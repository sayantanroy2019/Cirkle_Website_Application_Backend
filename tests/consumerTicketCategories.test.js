import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import {
    isCategorySoldOut,
    toConsumerCategory,
    areAllCategoriesSoldOut
} from '../src/utils/eventCategories.js';

const app = createApp();

const USER_PHONE = '+916565656577';
const P = 'ZZConsumerCat ';

let userId, userToken, eventId, emptyEventId;
const catalogIds = {};

const getEvent = id =>
    request(app).get(`/events/${id}`).set('Authorization', `Bearer ${userToken}`);

async function addCategory(name, pricePaise, admitsCount, ticketQuantity) {
    const row = await pool.query(
        `INSERT INTO event_ticket_categories (event_id, category_id, price_paise, admits_count, ticket_quantity)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [eventId, catalogIds[name], pricePaise, admitsCount, ticketQuantity]
    );
    return row.rows[0].id;
}

beforeAll(async () => {
    const login = await request(app).post('/auth/login').send({ phone: USER_PHONE });
    userToken = login.body.token;
    userId = (await pool.query('SELECT id FROM users WHERE phone = $1', [USER_PHONE])).rows[0].id;

    for (const n of ['Single', 'Couple', 'Unlimited', 'Zero']) {
        const r = await pool.query(
            'INSERT INTO ticket_categories (name) VALUES ($1) RETURNING id',
            [P + n]
        );
        catalogIds[n] = r.rows[0].id;
    }

    const ev = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size)
         VALUES ('ConsumerCat Event', 'club', 'del', now() + interval '20 days', 0, 3)
         RETURNING id`
    );
    eventId = ev.rows[0].id;

    const empty = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size)
         VALUES ('ConsumerCat Empty Event', 'club', 'del', now() + interval '20 days', 0, 3)
         RETURNING id`
    );
    emptyEventId = empty.rows[0].id;
});

afterAll(async () => {
    await pool.query('DELETE FROM tickets WHERE event_id = ANY($1)', [[eventId, emptyEventId]]);
    await pool.query('DELETE FROM orders WHERE event_id = ANY($1)', [[eventId, emptyEventId]]);
    await pool.query('DELETE FROM event_ticket_categories WHERE event_id = ANY($1)', [[eventId, emptyEventId]]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [[eventId, emptyEventId]]);
    await pool.query('DELETE FROM ticket_categories WHERE name LIKE $1', [P + '%']);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
});

// The maths, exercised with the real numbers Part 4 will supply. This is the
// part that must be right BEFORE the data exists — against live data today
// every peopleSold is 0, so none of these branches would ever be hit.
describe('isCategorySoldOut — with injected peopleSold', () => {

    const single = { admitsCount: 1, ticketQuantity: 10 };
    const couple = { admitsCount: 2, ticketQuantity: 10 };   // 20 people
    const unlimited = { admitsCount: 2, ticketQuantity: null };
    const zero = { admitsCount: 1, ticketQuantity: 0 };

    it('is not sold out with room to spare', () => {
        expect(isCategorySoldOut(single, 0)).toBe(false);
        expect(isCategorySoldOut(single, 9)).toBe(false);
    });

    it('is sold out exactly when the last place is taken', () => {
        expect(isCategorySoldOut(single, 10)).toBe(true);
    });

    // The reason the formula uses admitsCount rather than a plain seat count.
    it('sells out a couple tier when only one place remains', () => {
        expect(isCategorySoldOut(couple, 18)).toBe(false);  // 2 places left, fits
        expect(isCategorySoldOut(couple, 19)).toBe(true);   // 1 place left, a pair does not fit
        expect(isCategorySoldOut(couple, 20)).toBe(true);
    });

    it('never sells out an unlimited tier, however much has sold', () => {
        expect(isCategorySoldOut(unlimited, 0)).toBe(false);
        expect(isCategorySoldOut(unlimited, 100000)).toBe(false);
    });

    it('always treats a zero-quantity tier as sold out', () => {
        expect(isCategorySoldOut(zero, 0)).toBe(true);
    });

    it('defaults peopleSold to 0 when not supplied', () => {
        expect(isCategorySoldOut(single)).toBe(false);
        expect(isCategorySoldOut(zero)).toBe(true);
    });

});

describe('toConsumerCategory — shape and derivation', () => {

    const row = (qty, admits = 2) => ({
        id: 'row-id', category_name: 'Couple Pass',
        price_paise: 75000, admits_count: admits, ticket_quantity: qty
    });

    it('exposes booleans only — never inventory', () => {
        const c = toConsumerCategory(row(50));
        expect(Object.keys(c).sort()).toEqual([
            'admitsCount', 'available', 'categoryName', 'id', 'isUnlimited', 'pricePaise', 'soldOut'
        ]);
        expect(c).not.toHaveProperty('ticketQuantity');
        expect(c).not.toHaveProperty('peopleCapacity');
        expect(c).not.toHaveProperty('remaining');
    });

    it('marks a zero-quantity tier unavailable', () => {
        const c = toConsumerCategory(row(0));
        expect(c.soldOut).toBe(true);
        expect(c.available).toBe(false);
        expect(c.isUnlimited).toBe(false);
    });

    it('marks an unlimited tier available and never sold out', () => {
        const c = toConsumerCategory(row(null), 999);
        expect(c.isUnlimited).toBe(true);
        expect(c.soldOut).toBe(false);
        expect(c.available).toBe(true);
    });

    it('keeps available as the exact inverse of soldOut', () => {
        for (const [qty, sold] of [[10, 0], [10, 20], [0, 0], [null, 5]]) {
            const c = toConsumerCategory(row(qty), sold);
            expect(c.available).toBe(!c.soldOut);
        }
    });

});

describe('areAllCategoriesSoldOut', () => {

    it('is true only when every category is sold out', () => {
        expect(areAllCategoriesSoldOut([{ soldOut: true }, { soldOut: true }])).toBe(true);
        expect(areAllCategoriesSoldOut([{ soldOut: true }, { soldOut: false }])).toBe(false);
    });

    // Vacuous truth would mislabel every unconfigured event as sold out.
    it('is false for an event with no categories, not vacuously true', () => {
        expect(areAllCategoriesSoldOut([])).toBe(false);
    });

});

describe('GET /events/:id — ticketCategories', () => {

    it('returns an empty array for an unconfigured event, and does not call it sold out', async () => {
        const res = await getEvent(emptyEventId);
        expect(res.status).toBe(200);
        expect(res.body.event.ticketCategories).toEqual([]);
        expect(res.body.event.soldOut).toBe(false);
    });

    it('returns the categories cheapest first with the documented shape', async () => {
        await addCategory('Couple', 75000, 2, 50);
        await addCategory('Single', 40000, 1, 20);
        await addCategory('Unlimited', 90000, 2, null);
        await addCategory('Zero', 10000, 1, 0);

        const res = await getEvent(eventId);
        expect(res.status).toBe(200);

        const cats = res.body.event.ticketCategories;
        expect(cats.length).toBe(4);
        expect(cats.map(c => c.pricePaise)).toEqual([10000, 40000, 75000, 90000]);

        expect(Object.keys(cats[0]).sort()).toEqual([
            'admitsCount', 'available', 'categoryName', 'id', 'isUnlimited', 'pricePaise', 'soldOut'
        ]);

        const couple = cats.find(c => c.categoryName === P + 'Couple');
        expect(couple.admitsCount).toBe(2);
        expect(couple.isUnlimited).toBe(false);

        const unlimited = cats.find(c => c.categoryName === P + 'Unlimited');
        expect(unlimited.isUnlimited).toBe(true);
        expect(unlimited.soldOut).toBe(false);

        const zero = cats.find(c => c.categoryName === P + 'Zero');
        expect(zero.available).toBe(false);
        expect(zero.soldOut).toBe(true);
    });

    it('leaks no inventory numbers anywhere in the response', async () => {
        const res = await getEvent(eventId);
        const raw = JSON.stringify(res.body.event.ticketCategories);

        expect(raw).not.toMatch(/ticketQuantity|ticket_quantity|remaining|peopleCapacity|ticketsSold/);
        // The stocked quantities themselves must not appear as bare values.
        expect(res.body.event.ticketCategories.every(c => !('ticketQuantity' in c))).toBe(true);
    });

    it('exposes the event_ticket_categories row id for checkout to send back', async () => {
        const res = await getEvent(eventId);
        const stored = await pool.query(
            'SELECT id FROM event_ticket_categories WHERE event_id = $1',
            [eventId]
        );
        const storedIds = stored.rows.map(r => r.id).sort();
        expect(res.body.event.ticketCategories.map(c => c.id).sort()).toEqual(storedIds);
    });

    it('is not sold out while any category is available', async () => {
        const res = await getEvent(eventId);
        // The Zero tier is sold out, the others are not.
        expect(res.body.event.ticketCategories.some(c => c.soldOut)).toBe(true);
        expect(res.body.event.soldOut).toBe(false);
    });

    it('reports the event sold out when every category is', async () => {
        await pool.query('DELETE FROM event_ticket_categories WHERE event_id = $1', [eventId]);
        await addCategory('Zero', 10000, 1, 0);
        await addCategory('Single', 40000, 1, 0);

        const res = await getEvent(eventId);
        expect(res.body.event.ticketCategories.every(c => c.soldOut)).toBe(true);
        expect(res.body.event.soldOut).toBe(true);
    });

    it('leaves the existing gate fields and userHasTicket untouched', async () => {
        const res = await getEvent(eventId);
        const ev = res.body.event;

        expect(ev).toHaveProperty('userHasTicket');
        expect(ev.userHasTicket).toBe(false);
        expect(ev).toHaveProperty('eventType');
        expect(ev).toHaveProperty('invitationStatus');
        expect(ev).toHaveProperty('requireFacebook');
        expect(ev).toHaveProperty('requireInstagram');
        expect(ev).toHaveProperty('requireLinkedin');
        // events.price is gone as of Part 4; a tier range replaces it.
        expect(ev).not.toHaveProperty('price');
        expect(ev).toHaveProperty('priceRange');
    });

});

// Part 3 left this as a tripwire: it asserted the API reported a sold-out
// tier as available, because tickets carried no category. Part 4 supplied the
// link, so it now asserts the live behaviour it was waiting for.
describe('soldOut is live now that tickets carry their category', () => {

    it('flips to sold out once the tier stock is taken', async () => {
        await pool.query('DELETE FROM event_ticket_categories WHERE event_id = $1', [eventId]);
        const single = await addCategory('Single', 40000, 1, 1);   // one ticket of stock

        const before = await getEvent(eventId);
        expect(before.body.event.ticketCategories[0].available).toBe(true);

        const order = await pool.query(
            `INSERT INTO orders (user_id, event_id, event_ticket_category_id, status,
                                 base_price_paise, discount_paise, subtotal_paise,
                                 gst_percentage, gst_paise, total_paise, razorpay_order_id, expires_at)
             VALUES ($1, $2, $3, 'paid', 40000, 0, 40000, 18, 7200, 47200, 'order_consumercat', now() + interval '10 min')
             RETURNING id`,
            [userId, eventId, single]
        );
        const ticket = await pool.query(
            `INSERT INTO tickets (order_id, user_id, event_id, event_ticket_category_id)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [order.rows[0].id, userId, eventId, single]
        );

        const after = await getEvent(eventId);
        const tier = after.body.event.ticketCategories[0];
        expect(tier.soldOut).toBe(true);
        expect(tier.available).toBe(false);
        // Sole tier sold out means the event is sold out.
        expect(after.body.event.soldOut).toBe(true);

        await pool.query('DELETE FROM tickets WHERE id = $1', [ticket.rows[0].id]);
        await pool.query('DELETE FROM orders WHERE id = $1', [order.rows[0].id]);
    });

    it('counts a live hold too, not only issued tickets', async () => {
        await pool.query('DELETE FROM event_ticket_categories WHERE event_id = $1', [eventId]);
        const single = await addCategory('Single', 40000, 1, 1);

        const hold = await pool.query(
            `INSERT INTO orders (user_id, event_id, event_ticket_category_id, status,
                                 base_price_paise, discount_paise, subtotal_paise,
                                 gst_percentage, gst_paise, total_paise, razorpay_order_id, expires_at)
             VALUES ($1, $2, $3, 'created', 40000, 0, 40000, 18, 7200, 47200, 'order_hold_cat', now() + interval '10 min')
             RETURNING id`,
            [userId, eventId, single]
        );

        const res = await getEvent(eventId);
        expect(res.body.event.ticketCategories[0].soldOut).toBe(true);

        // An EXPIRED hold releases the seat again.
        await pool.query("UPDATE orders SET expires_at = now() - interval '1 min' WHERE id = $1", [hold.rows[0].id]);
        const released = await getEvent(eventId);
        expect(released.body.event.ticketCategories[0].soldOut).toBe(false);

        await pool.query('DELETE FROM orders WHERE id = $1', [hold.rows[0].id]);
    });

});
