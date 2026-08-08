import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

const app = createApp();

const ADMIN_EMAIL = 'zzlistdates-admin@cirkle.live';
const ADMIN_PASSWORD = 'ListDatesPass123!';
const USER_PHONE = '+919222222201';
const P = 'ZZListDates ';

let adminId, adminToken, userId;
let mixedEventId, singlePriceEventId, bareEventId, orderEventId;
const catalogIds = {};
const createdOrderIds = [];

const list = (query = '') =>
    request(app).get(`/admin/events${query}`).set('Authorization', `Bearer ${adminToken}`);

const detail = id =>
    request(app).get(`/admin/events/${id}`).set('Authorization', `Bearer ${adminToken}`);

const orders = (query = '') =>
    request(app).get(`/admin/orders${query}`).set('Authorization', `Bearer ${adminToken}`);

async function makeEvent(name) {
    const r = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size)
         VALUES ($1, 'club', 'del', now() + interval '20 days', 0, 3) RETURNING id`,
        [name]
    );
    return r.rows[0].id;
}

async function addCategory(eventId, catalogName, price, admits, qty) {
    await pool.query(
        `INSERT INTO event_ticket_categories (event_id, category_id, price_paise, admits_count, ticket_quantity)
         VALUES ($1, $2, $3, $4, $5)`,
        [eventId, catalogIds[catalogName], price, admits, qty]
    );
}

// An order created at a controlled instant, so the date filters have
// something exact to catch.
async function seedOrder(createdAtIso, ref) {
    const o = await pool.query(
        `INSERT INTO orders (user_id, event_id, status, base_price_paise, discount_paise,
                             subtotal_paise, gst_percentage, gst_paise, total_paise,
                             razorpay_order_id, expires_at, created_at)
         VALUES ($1, $2, 'paid', 50000, 0, 50000, 18, 9000, 59000, $3,
                 now() + interval '10 min', $4)
         RETURNING id`,
        [userId, orderEventId, ref, createdAtIso]
    );
    createdOrderIds.push(o.rows[0].id);
    return o.rows[0].id;
}

beforeAll(async () => {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const a = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ($1, $2, 'ListDates Admin', 'administrative') RETURNING id`,
        [ADMIN_EMAIL, hash]
    );
    adminId = a.rows[0].id;
    adminToken = (await request(app).post('/admin/auth/login')
        .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).body.token;

    await request(app).post('/auth/login').send({ phone: USER_PHONE });
    userId = (await pool.query('SELECT id FROM users WHERE phone = $1', [USER_PHONE])).rows[0].id;

    for (const n of ['Single', 'Couple', 'Unlimited']) {
        const r = await pool.query('INSERT INTO ticket_categories (name) VALUES ($1) RETURNING id', [P + n]);
        catalogIds[n] = r.rows[0].id;
    }

    mixedEventId       = await makeEvent(P + 'Mixed');
    singlePriceEventId = await makeEvent(P + 'SinglePrice');
    bareEventId        = await makeEvent(P + 'Bare');
    orderEventId       = await makeEvent(P + 'Orders');

    // Mixed: 50 Single tickets (1 each) + 20 Couple (2 each) + one unlimited.
    //   finite tickets = 70, finite people = 50 + 40 = 90, hasUnlimited = true
    //   prices 50000 / 90000 / 70000  -> range 50000..90000
    await addCategory(mixedEventId, 'Single',    50000, 1, 50);
    await addCategory(mixedEventId, 'Couple',    90000, 2, 20);
    await addCategory(mixedEventId, 'Unlimited', 70000, 1, null);

    // Single-price: two tiers at the same price.
    await addCategory(singlePriceEventId, 'Single', 60000, 1, 10);
    await addCategory(singlePriceEventId, 'Couple', 60000, 2, 5);

    // bareEventId deliberately has no categories.
});

afterAll(async () => {
    const evs = [mixedEventId, singlePriceEventId, bareEventId, orderEventId];
    await pool.query('DELETE FROM orders WHERE id = ANY($1)', [createdOrderIds]);
    await pool.query('DELETE FROM event_ticket_categories WHERE event_id = ANY($1)', [evs]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [evs]);
    await pool.query('DELETE FROM ticket_categories WHERE name LIKE $1', [P + '%']);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query('DELETE FROM audit_log WHERE admin_id = $1', [adminId]);
    await pool.query('DELETE FROM admins WHERE id = $1', [adminId]);
    await pool.end();
});

describe('B13 — capacitySummary and priceRange on the events list', () => {

    const find = (body, id) => body.events.find(e => e.id === id);

    it('returns both on every row', async () => {
        const res = await list();
        expect(res.status).toBe(200);

        const mixed = find(res.body, mixedEventId);
        expect(mixed.capacitySummary).toBeDefined();
        expect(mixed.priceRange).toBeDefined();
    });

    it('sums only finite tiers and flags the unlimited one', async () => {
        const mixed = find((await list()).body, mixedEventId);

        expect(mixed.capacitySummary).toEqual({
            totalTickets: 70,        // 50 + 20; the unlimited tier contributes nothing
            totalPeople:  90,        // 50*1 + 20*2
            hasUnlimited: true
        });
    });

    it('reports the min and max category price', async () => {
        const mixed = find((await list()).body, mixedEventId);
        expect(mixed.priceRange).toEqual({ minPaise: 50000, maxPaise: 90000 });
    });

    it('collapses to min === max when every tier is one price', async () => {
        const one = find((await list()).body, singlePriceEventId);
        expect(one.priceRange).toEqual({ minPaise: 60000, maxPaise: 60000 });
        expect(one.capacitySummary).toEqual({
            totalTickets: 15,        // 10 + 5
            totalPeople:  20,        // 10*1 + 5*2
            hasUnlimited: false
        });
    });

    it('gives a category-less event zeroed sums and a null range', async () => {
        const bare = find((await list()).body, bareEventId);
        expect(bare.priceRange).toBeNull();
        expect(bare.capacitySummary).toEqual({
            totalTickets: 0, totalPeople: 0, hasUnlimited: false
        });
    });

    // The point of sharing the derivation: the two views cannot drift.
    it('matches the detail endpoint exactly for the same event', async () => {
        const fromList = find((await list()).body, mixedEventId);
        const fromDetail = (await detail(mixedEventId)).body.event;

        expect(fromList.capacitySummary).toEqual(fromDetail.capacitySummary);
        expect(fromList.priceRange).toEqual(fromDetail.priceRange);
    });

    it('matches for the category-less event too', async () => {
        const fromList = find((await list()).body, bareEventId);
        const fromDetail = (await detail(bareEventId)).body.event;

        expect(fromList.capacitySummary).toEqual(fromDetail.capacitySummary);
        expect(fromList.priceRange).toEqual(fromDetail.priceRange);
        expect(fromDetail.priceRange).toBeNull();
    });

    // One aggregate query for the page, not one per event. Asserted by
    // counting the queries the request actually issues.
    it('does not N+1 — the category rollup is a single query', async () => {
        const original = pool.query.bind(pool);
        const categoryQueries = [];
        pool.query = (...args) => {
            const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
            if (text.includes('event_ticket_categories')) categoryQueries.push(text);
            return original(...args);
        };

        try {
            const res = await list();
            expect(res.status).toBe(200);
            // Many events on the page, but only one categories query.
            expect(res.body.events.length).toBeGreaterThan(3);
            expect(categoryQueries.length).toBe(1);
        } finally {
            pool.query = original;
        }
    });

});

describe('B4 — bare-date order filters are inclusive of the whole day', () => {

    // Chosen well in the past so no other suite's orders land in the window.
    const DAY = '2026-02-11';
    const PREV = '2026-02-10';
    const NEXT = '2026-02-12';
    const seeded = {};

    beforeAll(async () => {
        seeded.startOfDay = await seedOrder(`${DAY}T00:00:00.000Z`, 'zz_dates_start');
        seeded.midday     = await seedOrder(`${DAY}T13:45:00.000Z`, 'zz_dates_mid');
        seeded.endOfDay   = await seedOrder(`${DAY}T23:59:59.000Z`, 'zz_dates_end');
        seeded.dayBefore  = await seedOrder(`${PREV}T23:59:59.000Z`, 'zz_dates_before');
        seeded.dayAfter   = await seedOrder(`${NEXT}T00:00:00.000Z`, 'zz_dates_after');
    });

    const idsIn = body => body.data.map(o => o.id);

    // The reported bug: this returned zero.
    it('returns that day orders for from=X&to=X with the same bare date', async () => {
        const res = await orders(`?from=${DAY}&to=${DAY}&limit=100`);
        expect(res.status).toBe(200);

        const got = idsIn(res.body);
        expect(got).toContain(seeded.startOfDay);
        expect(got).toContain(seeded.midday);
        expect(got).toContain(seeded.endOfDay);
    });

    it('excludes the days either side', async () => {
        const got = idsIn((await orders(`?from=${DAY}&to=${DAY}&limit=100`)).body);
        expect(got).not.toContain(seeded.dayBefore);
        expect(got).not.toContain(seeded.dayAfter);
    });

    it('treats a bare from as start-of-day inclusive', async () => {
        const got = idsIn((await orders(`?from=${DAY}&to=${NEXT}&limit=100`)).body);
        expect(got).toContain(seeded.startOfDay);   // exactly 00:00:00 is in
        expect(got).not.toContain(seeded.dayBefore);
    });

    it('spans multiple days correctly', async () => {
        const got = idsIn((await orders(`?from=${PREV}&to=${NEXT}&limit=100`)).body);
        expect(got).toContain(seeded.dayBefore);
        expect(got).toContain(seeded.midday);
        expect(got).toContain(seeded.dayAfter);
    });

    // The admin portal's existing behaviour: full instants, honoured as given.
    it('honours an explicit time component instead of widening it', async () => {
        const res = await orders(`?from=${DAY}T00:00:00.000Z&to=${DAY}T12:00:00.000Z&limit=100`);
        const got = idsIn(res.body);

        expect(got).toContain(seeded.startOfDay);
        expect(got).not.toContain(seeded.midday);     // 13:45 is past the bound
        expect(got).not.toContain(seeded.endOfDay);
    });

    it('still works for the IST-day instants the frontend sends', async () => {
        // An IST business day is 18:30Z the previous day to 18:29:59Z on the day.
        const res = await orders(
            `?from=${PREV}T18:30:00.000Z&to=${DAY}T18:29:59.999Z&limit=100`
        );
        const got = idsIn(res.body);

        expect(got).toContain(seeded.midday);         // 13:45Z is inside the IST day
        expect(got).not.toContain(seeded.endOfDay);   // 23:59Z is the next IST day
    });

    it('rejects an unparseable date with 400, not a 500', async () => {
        expect((await orders('?from=not-a-date')).status).toBe(400);
        expect((await orders('?to=2026-13-45')).status).toBe(400);
    });

    it('leaves an unfiltered query unchanged', async () => {
        const res = await orders('?limit=1');
        expect(res.status).toBe(200);
        expect(res.body.total).toBeGreaterThan(0);
    });

});
