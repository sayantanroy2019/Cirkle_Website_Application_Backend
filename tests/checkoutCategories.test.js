import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { peopleSoldByCategory, isCategorySoldOut } from '../src/utils/eventCategories.js';
import { getGstPercentage, calculatePrice } from '../src/utils/pricing.js';

const app = createApp();

const P = 'ZZCheckout ';
// One buyer per concurrent slot — the one-ticket-per-event rule means a single
// user cannot race themselves.
const PHONES = Array.from({ length: 8 }, (_, i) => `+91777777700${i + 1}`);

const users = [];        // { id, token }
let eventId, inviteEventId, emptyEventId;
const cat = {};          // name -> event_ticket_categories id
const catalogIds = {};

const order = (token, body) =>
    request(app).post('/payments/orders').set('Authorization', `Bearer ${token}`).send(body);

async function addCategory(name, eventIdFor, pricePaise, admitsCount, ticketQuantity) {
    const row = await pool.query(
        `INSERT INTO event_ticket_categories (event_id, category_id, price_paise, admits_count, ticket_quantity)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [eventIdFor, catalogIds[name], pricePaise, admitsCount, ticketQuantity]
    );
    return row.rows[0].id;
}

// Wipes sales so each test starts from a known position.
async function resetSales() {
    await pool.query('DELETE FROM tickets WHERE event_id = ANY($1)', [[eventId, inviteEventId]]);
    await pool.query('DELETE FROM orders WHERE event_id = ANY($1)', [[eventId, inviteEventId]]);
}

// Issues a real paid ticket in a category, the way a completed checkout would.
async function sellTicket(userId, categoryId, ref) {
    const o = await pool.query(
        `INSERT INTO orders (user_id, event_id, event_ticket_category_id, status,
                             base_price_paise, discount_paise, subtotal_paise,
                             gst_percentage, gst_paise, total_paise, razorpay_order_id, expires_at)
         VALUES ($1, $2, $3, 'paid', 50000, 0, 50000, 18, 9000, 59000, $4, now() + interval '10 min')
         RETURNING id`,
        [userId, eventId, categoryId, ref]
    );
    await pool.query(
        `INSERT INTO tickets (order_id, user_id, event_id, event_ticket_category_id)
         VALUES ($1, $2, $3, $4)`,
        [o.rows[0].id, userId, eventId, categoryId]
    );
}

beforeAll(async () => {
    for (const phone of PHONES) {
        const login = await request(app).post('/auth/login').send({ phone });
        const u = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
        users.push({ id: u.rows[0].id, token: login.body.token, phone });
    }

    for (const n of ['Single', 'Couple', 'Unlimited', 'Zero', 'LastSeat']) {
        const r = await pool.query('INSERT INTO ticket_categories (name) VALUES ($1) RETURNING id', [P + n]);
        catalogIds[n] = r.rows[0].id;
    }

    const ev = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size)
         VALUES ('Checkout Cat Event', 'club', 'del', now() + interval '20 days', 0, 3) RETURNING id`
    );
    eventId = ev.rows[0].id;

    const inv = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size, event_type)
         VALUES ('Checkout Invite Event', 'club', 'del', now() + interval '20 days', 0, 3, 'invite_only') RETURNING id`
    );
    inviteEventId = inv.rows[0].id;

    const empty = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size)
         VALUES ('Checkout Empty Event', 'club', 'del', now() + interval '20 days', 0, 3) RETURNING id`
    );
    emptyEventId = empty.rows[0].id;

    cat.Single    = await addCategory('Single',    eventId, 40000, 1, 5);
    cat.Couple    = await addCategory('Couple',    eventId, 75000, 2, 4);    // 8 people
    cat.Unlimited = await addCategory('Unlimited', eventId, 90000, 1, null);
    cat.Zero      = await addCategory('Zero',      eventId, 10000, 1, 0);
    cat.LastSeat  = await addCategory('LastSeat',  eventId, 20000, 1, 1);    // exactly one
    cat.Invite    = await addCategory('Single',    inviteEventId, 40000, 1, 10);
});

afterAll(async () => {
    const evs = [eventId, inviteEventId, emptyEventId];
    await pool.query('DELETE FROM event_invitations WHERE event_id = ANY($1)', [evs]);
    await pool.query('DELETE FROM tickets WHERE event_id = ANY($1)', [evs]);
    await pool.query('DELETE FROM orders WHERE event_id = ANY($1)', [evs]);
    await pool.query('DELETE FROM event_ticket_categories WHERE event_id = ANY($1)', [evs]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [evs]);
    await pool.query('DELETE FROM ticket_categories WHERE name LIKE $1', [P + '%']);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [users.map(u => u.id)]);
    await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────
// The seat race. This is the reason the whole part exists.
// ─────────────────────────────────────────────────────────────────────────
describe('Concurrency — the seat race', () => {

    it('lets exactly ONE of two simultaneous buyers take the last seat', async () => {
        await resetSales();

        // Both requests are started before either is awaited, so they are in
        // flight against the DB at the same time. Promise.all on two already-
        // started promises is genuinely concurrent, not sequential.
        const a = order(users[0].token, { eventId, eventTicketCategoryId: cat.LastSeat });
        const b = order(users[1].token, { eventId, eventTicketCategoryId: cat.LastSeat });
        const [resA, resB] = await Promise.all([a, b]);

        const statuses = [resA.status, resB.status].sort();
        expect(statuses).toEqual([201, 409]);

        const loser = resA.status === 409 ? resA : resB;
        expect(loser.body.error).toBe('category_sold_out');

        // And the DB agrees: one hold, not two.
        const holds = await pool.query(
            `SELECT COUNT(*) c FROM orders
             WHERE event_ticket_category_id = $1 AND status = 'created' AND expires_at > now()`,
            [cat.LastSeat]
        );
        expect(parseInt(holds.rows[0].c, 10)).toBe(1);
    });

    it('never oversells when six buyers rush five seats', async () => {
        await resetSales();

        const attempts = users.slice(0, 6).map(u =>
            order(u.token, { eventId, eventTicketCategoryId: cat.Single })
        );
        const results = await Promise.all(attempts);

        const created = results.filter(r => r.status === 201).length;
        const refused = results.filter(r => r.status === 409).length;

        expect(created).toBe(5);          // exactly the stock
        expect(refused).toBe(1);
        expect(created + refused).toBe(6);

        const holds = await pool.query(
            `SELECT COUNT(*) c FROM orders
             WHERE event_ticket_category_id = $1 AND status = 'created' AND expires_at > now()`,
            [cat.Single]
        );
        expect(parseInt(holds.rows[0].c, 10)).toBe(5);
    });

    // Per-category locking, not event-wide: the whole point of locking the
    // category row rather than the event row.
    it('does not block buyers of different categories of the same event', async () => {
        await resetSales();

        const results = await Promise.all([
            order(users[0].token, { eventId, eventTicketCategoryId: cat.Single }),
            order(users[1].token, { eventId, eventTicketCategoryId: cat.Couple }),
            order(users[2].token, { eventId, eventTicketCategoryId: cat.Unlimited })
        ]);

        expect(results.map(r => r.status)).toEqual([201, 201, 201]);
    });

});

describe('Capacity in people, not seats', () => {

    // NOTE ON THE "one place can't seat a pair" CASE.
    //
    // Within a single tier every ticket admits the same number, so peopleSold
    // is always a multiple of admitsCount and the odd-one-out state (19 of 20)
    // is unreachable through the API — a Couple tier goes 18 → 20, never 19.
    // The formula still has to be right, because it is what makes the tier
    // stop at its people-capacity rather than its ticket count, so it is
    // asserted directly against injected values here and in Part 3's units.
    it('applies the people formula, including the unreachable-by-API odd case', () => {
        const couple = { admitsCount: 2, ticketQuantity: 10 };   // 20 people
        expect(isCategorySoldOut(couple, 18)).toBe(false);   // a pair fits
        expect(isCategorySoldOut(couple, 19)).toBe(true);    // one place cannot seat a pair
        expect(isCategorySoldOut(couple, 20)).toBe(true);
    });

    it('stops a Couple tier at its people-capacity, not its ticket count', async () => {
        await resetSales();

        // 4 couples = 8 people = the tier's whole capacity.
        for (let i = 0; i < 4; i++) {
            await sellTicket(users[i].id, cat.Couple, `order_couple_${i}`);
        }
        const sold = await peopleSoldByCategory(eventId);
        expect(sold[cat.Couple]).toBe(8);

        const res = await order(users[4].token, { eventId, eventTicketCategoryId: cat.Couple });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('category_sold_out');

        // A different tier with room is unaffected — capacity is per category.
        const single = await order(users[4].token, { eventId, eventTicketCategoryId: cat.Single });
        expect(single.status).toBe(201);
    });

    it('never blocks an unlimited tier, whatever has sold', async () => {
        await resetSales();
        for (let i = 0; i < 8; i++) {
            await sellTicket(users[i].id, cat.Unlimited, `order_unl_${i}`);
        }

        const sold = await peopleSoldByCategory(eventId);
        expect(sold[cat.Unlimited]).toBe(8);

        await pool.query('DELETE FROM tickets WHERE user_id = $1 AND event_id = $2', [users[0].id, eventId]);
        await pool.query('DELETE FROM orders WHERE user_id = $1 AND event_id = $2', [users[0].id, eventId]);

        const res = await order(users[0].token, { eventId, eventTicketCategoryId: cat.Unlimited });
        expect(res.status).toBe(201);
    });

    it('refuses a zero-quantity tier', async () => {
        await resetSales();
        const res = await order(users[0].token, { eventId, eventTicketCategoryId: cat.Zero });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('category_sold_out');
    });

});

describe('Category validation', () => {

    it('requires a category', async () => {
        await resetSales();
        const res = await order(users[0].token, { eventId });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/eventTicketCategoryId/);
    });

    it('rejects a category belonging to another event', async () => {
        await resetSales();
        const res = await order(users[0].token, { eventId, eventTicketCategoryId: cat.Invite });
        expect(res.status).toBe(404);
    });

    it('refuses an event with no categories as not-for-sale', async () => {
        const res = await order(users[0].token, {
            eventId: emptyEventId,
            eventTicketCategoryId: cat.Single
        });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('not_available_for_sale');
    });

});

describe('Gates still fire before category and capacity', () => {

    it('returns social_handles_required even when the tier has room', async () => {
        await resetSales();
        await pool.query('UPDATE events SET require_instagram = true WHERE id = $1', [eventId]);
        await pool.query('UPDATE profiles SET instagram = NULL WHERE user_id = $1', [users[0].id]);

        const res = await order(users[0].token, { eventId, eventTicketCategoryId: cat.Single });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('social_handles_required');

        await pool.query('UPDATE events SET require_instagram = false WHERE id = $1', [eventId]);
    });

    // The gate must beat a SOLD OUT tier too — otherwise the user is told the
    // wrong reason they cannot buy.
    it('returns social_handles_required rather than sold-out when both apply', async () => {
        await resetSales();
        await pool.query('UPDATE events SET require_instagram = true WHERE id = $1', [eventId]);
        await pool.query('UPDATE profiles SET instagram = NULL WHERE user_id = $1', [users[0].id]);

        const res = await order(users[0].token, { eventId, eventTicketCategoryId: cat.Zero });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('social_handles_required');

        await pool.query('UPDATE events SET require_instagram = false WHERE id = $1', [eventId]);
    });

    it('returns the invite error before touching capacity', async () => {
        const res = await order(users[0].token, {
            eventId: inviteEventId,
            eventTicketCategoryId: cat.Invite
        });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/accepted invitation is required/i);
    });

});

describe('Price freeze — from the category', () => {

    it('freezes the category price, and a later reprice does not move it', async () => {
        await resetSales();

        const res = await order(users[0].token, { eventId, eventTicketCategoryId: cat.Couple });
        expect(res.status).toBe(201);
        expect(res.body.breakdown.basePricePaise).toBe(75000);   // the Couple price, not the event's

        const stored = await pool.query(
            'SELECT base_price_paise, event_ticket_category_id FROM orders WHERE id = $1',
            [res.body.orderId]
        );
        expect(stored.rows[0].base_price_paise).toBe(75000);
        expect(stored.rows[0].event_ticket_category_id).toBe(cat.Couple);

        // Admin reprices the tier afterwards.
        await pool.query('UPDATE event_ticket_categories SET price_paise = 999999 WHERE id = $1', [cat.Couple]);

        const after = await pool.query('SELECT base_price_paise FROM orders WHERE id = $1', [res.body.orderId]);
        expect(after.rows[0].base_price_paise).toBe(75000);      // untouched

        await pool.query('UPDATE event_ticket_categories SET price_paise = 75000 WHERE id = $1', [cat.Couple]);
    });

    it('charges different amounts for different tiers of the same event', async () => {
        await resetSales();

        const single = await order(users[0].token, { eventId, eventTicketCategoryId: cat.Single });
        const couple = await order(users[1].token, { eventId, eventTicketCategoryId: cat.Couple });

        expect(single.body.breakdown.basePricePaise).toBe(40000);
        expect(couple.body.breakdown.basePricePaise).toBe(75000);
    });

    it('keeps the money identities intact', async () => {
        await resetSales();
        const res = await order(users[0].token, { eventId, eventTicketCategoryId: cat.Couple });
        const b = res.body.breakdown;

        expect(b.basePricePaise - b.discountPaise).toBe(b.subtotalPaise);
        expect(b.subtotalPaise + b.gstPaise).toBe(b.totalPaise);

        // And matches an independent computation from the category price.
        const gst = await getGstPercentage();
        expect(b).toMatchObject(calculatePrice(75000, 0, gst));
    });

});

describe('Sold counts are live', () => {

    it('counts a live hold against the tier, then the ticket once paid', async () => {
        await resetSales();

        const res = await order(users[0].token, { eventId, eventTicketCategoryId: cat.Couple });
        expect(res.status).toBe(201);

        // The hold alone already consumes people.
        let sold = await peopleSoldByCategory(eventId);
        expect(sold[cat.Couple]).toBe(2);

        // Convert the hold into a paid ticket, as confirmation would.
        await pool.query("UPDATE orders SET status = 'paid' WHERE id = $1", [res.body.orderId]);
        await pool.query(
            `INSERT INTO tickets (order_id, user_id, event_id, event_ticket_category_id)
             VALUES ($1, $2, $3, $4)`,
            [res.body.orderId, users[0].id, eventId, cat.Couple]
        );

        // Still 2, not 4 — a paid order is represented by its ticket, never both.
        sold = await peopleSoldByCategory(eventId);
        expect(sold[cat.Couple]).toBe(2);
    });

    it('surfaces real soldOut on the consumer endpoint', async () => {
        await resetSales();
        for (let i = 0; i < 5; i++) {
            await sellTicket(users[i].id, cat.Single, `order_soldout_${i}`);
        }

        const res = await request(app)
            .get(`/events/${eventId}`)
            .set('Authorization', `Bearer ${users[6].token}`);

        const single = res.body.event.ticketCategories.find(c => c.categoryName === P + 'Single');
        expect(single.soldOut).toBe(true);
        expect(single.available).toBe(false);

        // Other tiers unaffected, so the event is not sold out.
        expect(res.body.event.soldOut).toBe(false);
    });

});

describe('Coupons discount the category price', () => {

    const CODE = 'ZZCHECKOUTCOUPON';
    let couponId;

    beforeAll(async () => {
        const c = await pool.query(
            `INSERT INTO coupons (code, discount_flat_paise, is_active, valid_from, valid_until, usage_limit_total, usage_limit_per_user)
             VALUES ($1, 10000, true, now() - interval '1 day', now() + interval '30 days', 100, 1)
             RETURNING id`,
            [CODE]
        );
        couponId = c.rows[0].id;
    });

    afterAll(async () => {
        await pool.query('DELETE FROM coupon_redemptions WHERE coupon_id = $1', [couponId]);
        // Orders carry an FK to the coupon — clear them before it.
        await pool.query('DELETE FROM orders WHERE coupon_id = $1', [couponId]);
        await pool.query('DELETE FROM coupons WHERE id = $1', [couponId]);
    });

    it('previews against the chosen tier, not an event price', async () => {
        const single = await request(app)
            .post('/coupons/validate')
            .set('Authorization', `Bearer ${users[0].token}`)
            .send({ code: CODE, eventId, eventTicketCategoryId: cat.Single });

        const couple = await request(app)
            .post('/coupons/validate')
            .set('Authorization', `Bearer ${users[0].token}`)
            .send({ code: CODE, eventId, eventTicketCategoryId: cat.Couple });

        expect(single.status).toBe(200);
        expect(single.body.breakdown.basePricePaise).toBe(40000);
        expect(single.body.breakdown.discountPaise).toBe(10000);
        expect(couple.body.breakdown.basePricePaise).toBe(75000);
    });

    it('requires a category to preview against', async () => {
        const res = await request(app)
            .post('/coupons/validate')
            .set('Authorization', `Bearer ${users[0].token}`)
            .send({ code: CODE, eventId });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/eventTicketCategoryId/);
    });

    it('preview and charge agree exactly', async () => {
        await resetSales();

        const preview = await request(app)
            .post('/coupons/validate')
            .set('Authorization', `Bearer ${users[0].token}`)
            .send({ code: CODE, eventId, eventTicketCategoryId: cat.Couple });

        const charged = await order(users[0].token, {
            eventId, eventTicketCategoryId: cat.Couple, couponCode: CODE
        });

        expect(charged.status).toBe(201);
        expect(charged.body.breakdown).toEqual(preview.body.breakdown);
    });

});
