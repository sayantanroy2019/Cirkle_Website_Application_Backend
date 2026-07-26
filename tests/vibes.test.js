import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

const app = createApp();

// A male viewer in Delhi, plus a controlled cast of ticket-holders whose
// order in the feed we can predict exactly.
const VIEWER_PHONE = '+916333300000';

let viewerToken, viewerId;
const created = { users: [], events: [], tickets: [] };

// Helper: make a user with a given gender + city, onboarded enough to appear
async function makePerson(phone, firstName, gender, cityId) {
    const login = await request(app).post('/auth/login').send({ phone });
    const u = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
    const id = u.rows[0].id;
    await pool.query(
        `UPDATE profiles
         SET first_name = $2, date_of_birth = '1998-01-01', gender = $3, city_id = $4
         WHERE user_id = $1`,
        [id, firstName, gender, cityId]
    );
    created.users.push(phone);
    return id;
}

// Helper: make an event in a city on a given day-offset, return its id
async function makeEvent(name, cityId, daysOut) {
    const ev = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size)
         VALUES ($1, 'club', $2, now() + ($3 || ' days')::interval, 50000, 3)
         RETURNING id`,
        [name, cityId, String(daysOut)]
    );
    created.events.push(ev.rows[0].id);
    return ev.rows[0].id;
}

// Helper: give a person a paid ticket to an event (bypasses payment — direct insert)
async function giveTicket(personId, eventId) {
    // A minimal paid order, then a ticket (mirrors what confirmOrderPaid does)
    const ord = await pool.query(
        `INSERT INTO orders (user_id, event_id, status, base_price_paise, discount_paise,
                             subtotal_paise, gst_percentage, gst_paise, total_paise,
                             razorpay_order_id, expires_at)
         VALUES ($1, $2, 'paid', 50000, 0, 50000, 18, 9000, 59000, $3, now() + interval '10 min')
         RETURNING id`,
        [personId, eventId, `order_test_${Math.random().toString(36).slice(2, 12)}`]
    );
    const tk = await pool.query(
        `INSERT INTO tickets (order_id, user_id, event_id) VALUES ($1, $2, $3) RETURNING id`,
        [ord.rows[0].id, personId, eventId]
    );
    created.tickets.push(tk.rows[0].id);
    return tk.rows[0].id;
}

beforeAll(async () => {
    // Viewer: male, Delhi
    const login = await request(app).post('/auth/login').send({ phone: VIEWER_PHONE });
    viewerToken = login.body.token;
    const v = await pool.query('SELECT id FROM users WHERE phone = $1', [VIEWER_PHONE]);
    viewerId = v.rows[0].id;
    await pool.query(
        `UPDATE profiles SET first_name = 'Viewer', date_of_birth = '1998-01-01',
                             gender = 'man', city_id = 'del' WHERE user_id = $1`,
        [viewerId]
    );

    // Events: one in Delhi (soon), one in Mumbai (soon)
    const delEvent = await makeEvent('TEST Del Event', 'del', 10);
    const mumEvent = await makeEvent('TEST Other City Event', 'blr', 10);

    // The cast, each with a ticket:
    //   womanDel  → tier 1 (female, my city)
    //   womanMum  → tier 2 (female, other city)
    //   manDel    → tier 3 (male, my city)
    //   manMum    → tier 4 (male, other city)
    //   nbDel     → tier 5 (non_binary)
    const womanDel = await makePerson('+916333300001', 'WomanDel', 'woman', 'del');
    const womanMum = await makePerson('+916333300002', 'WomanMum', 'woman', 'blr');
    const manDel   = await makePerson('+916333300003', 'ManDel',   'man',   'del');
    const manMum   = await makePerson('+916333300004', 'ManMum',   'man',   'blr');
    const nbDel    = await makePerson('+916333300005', 'NbDel',    'non_binary', 'del');

    await giveTicket(womanDel, delEvent);
    await giveTicket(womanMum, mumEvent);
    await giveTicket(manDel,   delEvent);
    await giveTicket(manMum,   mumEvent);
    await giveTicket(nbDel,    delEvent);

    // The viewer also holds a ticket — must NOT appear in their own feed
    await giveTicket(viewerId, delEvent);
}, 30000);

afterAll(async () => {
    await pool.query('DELETE FROM tickets WHERE id = ANY($1)', [created.tickets]);
    await pool.query('DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1))',
        [[VIEWER_PHONE, ...created.users]]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [created.events]);
    await pool.query('DELETE FROM users WHERE phone = ANY($1)', [[VIEWER_PHONE, ...created.users]]);
    await pool.end();
});

describe('GET /vibes', () => {

    it('requires auth', async () => {
        const res = await request(app).get('/vibes');
        expect(res.status).toBe(401);
    });

    it('excludes the viewer own ticket', async () => {
        const res = await request(app).get('/vibes').set('Authorization', `Bearer ${viewerToken}`);
        expect(res.status).toBe(200);
        const names = res.body.cards.map(c => c.person.firstName);
        expect(names).not.toContain('Viewer');
    });

    it('orders by the five tiers for a male viewer', async () => {
        const res = await request(app).get('/vibes').set('Authorization', `Bearer ${viewerToken}`);
        const names = res.body.cards.map(c => c.person.firstName);

        // Filter to just our test cast (other data may exist in the DB)
        const ours = names.filter(n =>
            ['WomanDel', 'WomanMum', 'ManDel', 'ManMum', 'NbDel'].includes(n));

        // Expected tier order for a male Delhi viewer:
        // WomanDel (t1) → WomanMum (t2) → ManDel (t3) → ManMum (t4) → NbDel (t5)
        expect(ours).toEqual(['WomanDel', 'WomanMum', 'ManDel', 'ManMum', 'NbDel']);
    });

    it('includes event, going count, and profile on each card', async () => {
        const res = await request(app).get('/vibes').set('Authorization', `Bearer ${viewerToken}`);
        const card = res.body.cards.find(c => c.person.firstName === 'WomanDel');
        expect(card).toBeDefined();
        expect(card.event.name).toBe('TEST Del Event');
        expect(card.event.goingCount).toBeGreaterThanOrEqual(3); // womanDel + manDel + nbDel + viewer
        expect(card.person.age).toBeDefined();
        expect(card.event.eventType).toBeDefined();
    });

    it('excludes past events', async () => {
        // Create a past event with a ticket — it must not appear
        const pastEvent = await pool.query(
            `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size)
             VALUES ('TEST Past Event', 'club', 'del', now() - interval '2 days', 50000, 3)
             RETURNING id`
        );
        created.events.push(pastEvent.rows[0].id);

        const login = await request(app).post('/auth/login').send({ phone: '+916333300009' });
        const pu = await pool.query('SELECT id FROM users WHERE phone = $1', ['+916333300009']);
        created.users.push('+916333300009');
        await pool.query(
            `UPDATE profiles SET first_name = 'PastGoer', date_of_birth='1998-01-01',
                    gender='woman', city_id='del' WHERE user_id = $1`, [pu.rows[0].id]);
        await giveTicket(pu.rows[0].id, pastEvent.rows[0].id);

        const res = await request(app).get('/vibes').set('Authorization', `Bearer ${viewerToken}`);
        const names = res.body.cards.map(c => c.person.firstName);
        expect(names).not.toContain('PastGoer');
    });
});