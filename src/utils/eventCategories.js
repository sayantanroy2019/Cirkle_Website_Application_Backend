import { pool } from '../config/db.js';

/**
 * Ticket categories as configured on one event.
 *
 * ticket_quantity is inventory in TICKETS — what the admin types — and carries
 * three distinct states:
 *   null   -> unlimited; checkout skips the capacity check for this tier
 *   0      -> the tier exists but has nothing to sell (sold out / not stocked)
 *   N > 0  -> capped; people-capacity = admits_count * N
 *
 * null and 0 are opposites and must never be collapsed into one another.
 *
 * One booking is one ticket = one QR. admits_count is how many people that
 * single ticket lets through the door, so people-capacity is always derived,
 * never stored and never typed by the admin.
 */

const MAX_CATEGORIES = 20;

/**
 * Validates the write payload's shape. Catalogue existence and active-ness are
 * checked separately against the DB by the caller — this covers everything
 * that can be decided without a query.
 *
 * @returns {string|null} an error message, or null when the payload is fine
 */
export function validateCategoriesPayload(categories) {
    if (!Array.isArray(categories)) {
        return 'categories must be an array';
    }
    if (categories.length > MAX_CATEGORIES) {
        return `Provide at most ${MAX_CATEGORIES} ticket categories`;
    }

    for (const c of categories) {
        if (!c || typeof c !== 'object') {
            return 'Each category must be an object';
        }
        if (!c.categoryId || typeof c.categoryId !== 'string') {
            return 'Each category must have a categoryId';
        }
        if (!Number.isInteger(c.pricePaise) || c.pricePaise < 0) {
            return 'Each category must have a pricePaise that is a non-negative integer';
        }
        if (!Number.isInteger(c.admitsCount) || c.admitsCount < 1) {
            return 'Each category must have an admitsCount of at least 1';
        }
        // undefined is treated as unlimited too, so a client that omits the
        // field gets the same result as one that sends null explicitly.
        const qty = c.ticketQuantity ?? null;
        if (qty !== null && (!Number.isInteger(qty) || qty < 0)) {
            return 'ticketQuantity must be null (unlimited) or a non-negative integer';
        }
    }

    const ids = categories.map(c => c.categoryId);
    if (new Set(ids).size !== ids.length) {
        return 'The same ticket category cannot be listed twice on one event';
    }

    return null;
}

/**
 * Turns a DB row into the API shape, adding the derived read-only fields.
 * peopleCapacity is null for an unlimited tier — not 0, and not Infinity.
 */
export function toCategoryResponse(row, ticketsSold = 0) {
    const ticketQuantity = row.ticket_quantity;
    const isUnlimited = ticketQuantity === null;

    return {
        id:             row.id,
        categoryId:     row.category_id,
        categoryName:   row.category_name,
        pricePaise:     row.price_paise,
        admitsCount:    row.admits_count,
        ticketQuantity,
        peopleCapacity: isUnlimited ? null : row.admits_count * ticketQuantity,
        ticketsSold,
        isUnlimited
    };
}

/**
 * Event-level rollup. Finite tiers are summed; unlimited ones are excluded
 * from the sums and flagged instead, so the UI can show the finite subtotal
 * AND know to display the event total as "Unlimited".
 */
export function buildCapacitySummary(categories) {
    const finite = categories.filter(c => !c.isUnlimited);

    return {
        totalTickets: finite.reduce((sum, c) => sum + c.ticketQuantity, 0),
        totalPeople:  finite.reduce((sum, c) => sum + c.peopleCapacity, 0),
        hasUnlimited: categories.some(c => c.isUnlimited)
    };
}

/**
 * Per-category sold counts for an event.
 *
 * PART 4 HOOK — returns all zeros today. Tickets do not yet reference the
 * event_ticket_categories row they were bought from, so there is nothing to
 * count. When Part 4 adds that column this becomes a GROUP BY and every
 * caller below starts enforcing for real, with no other change needed.
 *
 * @returns {Promise<Record<string, number>>} categoryId -> tickets sold
 */
export async function ticketsSoldByCategory(eventId) {
    const existing = await pool.query(
        'SELECT category_id FROM event_ticket_categories WHERE event_id = $1',
        [eventId]
    );
    return Object.fromEntries(existing.rows.map(r => [r.category_id, 0]));
}

/**
 * Guards a category replacement against destroying tickets people already
 * bought. Two things are refused:
 *
 *   - removing a category that has sold tickets
 *   - cutting a category's ticketQuantity below what it has already sold
 *
 * Blocking is the safe default: the alternative (silently orphaning or
 * over-selling) turns an admin typo into a support incident at the door.
 * Going unlimited is always allowed — it can only ever add headroom.
 *
 * Inert until ticketsSoldByCategory() returns real numbers in Part 4; the
 * rule is expressed here now so there is one place to switch on.
 *
 * @returns {string|null} an error message, or null when the change is safe
 */
export function findBlockedCategoryChanges(existingRows, incoming, soldCounts) {
    const incomingById = new Map(incoming.map(c => [c.categoryId, c]));

    for (const row of existingRows) {
        const sold = soldCounts[row.category_id] ?? 0;
        if (sold === 0) {
            continue;
        }

        const replacement = incomingById.get(row.category_id);
        if (!replacement) {
            return `Cannot remove the "${row.category_name}" category — ${sold} ticket(s) have already been sold in it`;
        }

        const qty = replacement.ticketQuantity ?? null;
        if (qty !== null && qty < sold) {
            return `Cannot reduce "${row.category_name}" to ${qty} tickets — ${sold} have already been sold`;
        }
    }

    return null;
}

/**
 * Reads an event's categories, joined to the catalogue for display names and
 * ordered stably. Used by both the admin detail endpoint and the write paths
 * (to return the saved state).
 */
export async function fetchEventCategories(eventId, queryable = pool) {
    const result = await queryable.query(
        `SELECT etc.id, etc.category_id, etc.price_paise, etc.admits_count,
                etc.ticket_quantity, etc.created_at,
                tc.name AS category_name
         FROM event_ticket_categories etc
         JOIN ticket_categories tc ON tc.id = etc.category_id
         WHERE etc.event_id = $1
         ORDER BY etc.price_paise ASC, tc.name ASC, etc.id ASC`,
        [eventId]
    );

    const sold = await ticketsSoldByCategory(eventId);
    return result.rows.map(row => toCategoryResponse(row, sold[row.category_id] ?? 0));
}

/**
 * Replaces an event's category set inside the caller's transaction.
 *
 * Upsert by (event_id, category_id), NOT delete-and-reinsert. The artists
 * lineup made the same call for a different reason (photo keys); here it is
 * because Part 4 will point tickets at the event_ticket_categories row, and
 * reinserting on every edit would change those ids and orphan the link. The
 * natural key is categoryId, which the payload already carries, so unlike the
 * artists endpoint the client never has to send row ids back.
 *
 * Assumes the payload has been validated and the removal guard has passed.
 */
export async function replaceEventCategories(client, eventId, categories) {
    const keptCategoryIds = categories.map(c => c.categoryId);

    await client.query(
        `DELETE FROM event_ticket_categories
         WHERE event_id = $1 AND NOT (category_id = ANY($2::uuid[]))`,
        [eventId, keptCategoryIds]
    );

    for (const c of categories) {
        await client.query(
            `INSERT INTO event_ticket_categories
                (event_id, category_id, price_paise, admits_count, ticket_quantity)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (event_id, category_id) DO UPDATE SET
                price_paise     = EXCLUDED.price_paise,
                admits_count    = EXCLUDED.admits_count,
                ticket_quantity = EXCLUDED.ticket_quantity`,
            [eventId, c.categoryId, c.pricePaise, c.admitsCount, c.ticketQuantity ?? null]
        );
    }
}

/**
 * Is this category sold out?
 *
 *   soldOut = (peopleSold + admitsCount) > (admitsCount * ticketQuantity)
 *
 * The question is "is there room for one more ticket of THIS size", not "are
 * there any seats left" — a Couple Pass needs two places, so a tier with one
 * place spare is sold out for it.
 *
 * Unlimited tiers are never sold out. A ticketQuantity of 0 always is: there
 * is nothing to sell, which is the opposite of unlimited and must not be
 * confused with it.
 *
 * Pure, so it can be tested with real numbers before anything produces them.
 *
 * @param {{admitsCount: number, ticketQuantity: number|null}} category
 * @param {number} peopleSold  people already admitted by this tier's tickets
 */
export function isCategorySoldOut({ admitsCount, ticketQuantity }, peopleSold = 0) {
    if (ticketQuantity === null) {
        return false;
    }
    return (peopleSold + admitsCount) > (admitsCount * ticketQuantity);
}

/**
 * The consumer-facing shape. Deliberately booleans only — no ticketQuantity,
 * no "N remaining". Exact inventory invites scraping and tells a buyer more
 * than they need; whether they can buy is the entire question.
 */
export function toConsumerCategory(row, peopleSold = 0) {
    const category = { admitsCount: row.admits_count, ticketQuantity: row.ticket_quantity };
    const soldOut = isCategorySoldOut(category, peopleSold);

    return {
        // The event_ticket_categories row id — the frontend sends this back at
        // checkout in Part 4 to say which category was chosen.
        id:           row.id,
        categoryName: row.category_name,
        pricePaise:   row.price_paise,
        admitsCount:  row.admits_count,
        isUnlimited:  row.ticket_quantity === null,
        soldOut,
        available:    !soldOut
    };
}

/**
 * People already admitted per category, for the sold-out maths.
 *
 * PART 4 HOOK — all zeros today, for the same reason as
 * ticketsSoldByCategory(): tickets carry no reference to the category they
 * were bought from, so there is nothing to count and every category computes
 * as not-sold-out. Correct but inert. Part 4 replaces the body with a GROUP BY
 * over tickets joined to their category, summing admits_count, and every
 * caller starts working with no other change.
 *
 * @returns {Promise<Record<string, number>>} event_ticket_categories.id -> people sold
 */
export async function peopleSoldByCategory(eventId) {
    const rows = await pool.query(
        'SELECT id FROM event_ticket_categories WHERE event_id = $1',
        [eventId]
    );
    return Object.fromEntries(rows.rows.map(r => [r.id, 0]));
}

/**
 * The consumer event-detail view of an event's categories, ordered cheapest
 * first so the selector reads naturally.
 */
export async function fetchConsumerTicketCategories(eventId) {
    const result = await pool.query(
        `SELECT etc.id, etc.price_paise, etc.admits_count, etc.ticket_quantity,
                tc.name AS category_name
         FROM event_ticket_categories etc
         JOIN ticket_categories tc ON tc.id = etc.category_id
         WHERE etc.event_id = $1
         ORDER BY etc.price_paise ASC, tc.name ASC, etc.id ASC`,
        [eventId]
    );

    const peopleSold = await peopleSoldByCategory(eventId);
    return result.rows.map(row => toConsumerCategory(row, peopleSold[row.id] ?? 0));
}

/**
 * The event is sold out only when every category is. One available category
 * means the event is buyable.
 *
 * An event with NO categories is not "sold out" — it is unconfigured, which
 * is a different state the frontend renders as "not yet available" off the
 * empty array. Returning true here (the vacuous AND over an empty set) would
 * mislabel every draft event as sold out, so callers handle the empty case
 * separately.
 */
export function areAllCategoriesSoldOut(categories) {
    return categories.length > 0 && categories.every(c => c.soldOut);
}

/**
 * Confirms every categoryId exists in the catalogue AND is active.
 * Retired names stay valid on events that already reference them, but must not
 * be selectable for a new configuration — otherwise retiring a name would do
 * nothing.
 *
 * @returns {string|null} an error message, or null when all ids are usable
 */
export async function validateCatalogIds(client, categories, existingRows = []) {
    if (categories.length === 0) {
        return null;
    }

    const ids = categories.map(c => c.categoryId);
    const found = await client.query(
        'SELECT id, name, is_active FROM ticket_categories WHERE id = ANY($1::uuid[])',
        [ids]
    );
    const byId = new Map(found.rows.map(r => [r.id, r]));

    // A category already on this event may keep its retired name — the admin
    // is editing price or stock, not re-selecting it from the dropdown.
    const alreadyOnEvent = new Set(existingRows.map(r => r.category_id));

    for (const id of ids) {
        const row = byId.get(id);
        if (!row) {
            return 'One or more ticket categories do not exist';
        }
        if (!row.is_active && !alreadyOnEvent.has(id)) {
            return `The "${row.name}" ticket category has been retired and cannot be added to an event`;
        }
    }

    return null;
}
