import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

const app = createApp();

const ADMIN_EMAIL = 'test-admin-revcat@cirkle.live';
const ADMIN_PASSWORD = 'AdminRevCatPass123!';
const P = 'ZZRevCat ';
const PHONES = ['+919111111101', '+919111111102', '+919111111103', '+919111111104'];

let adminId, adminToken, eventId;
const users = [];
const cat = {};
const catalogIds = {};

// Deliberately chosen so every identity is checkable by hand:
//   Single: 40000 base, no discount   -> subtotal 40000, gst 18% = 7200, total 47200
//   Couple: 75000 base, 5000 discount -> subtotal 70000, gst 18% = 12600, total 82600
const SINGLE = { base: 40000, discount: 0,    subtotal: 40000, gst: 7200,  total: 47200 };
const COUPLE = { base: 75000, discount: 5000, subtotal: 70000, gst: 12600, total: 82600 };

async function seedPaidSale(userId, categoryId, money, ref) {
    const o = await pool.query(
        `INSERT INTO orders (user_id, event_id, event_ticket_category_id, status,
                             base_price_paise, discount_paise, subtotal_paise,
                             gst_percentage, gst_paise, total_paise, razorpay_order_id, expires_at)
         VALUES ($1, $2, $3, 'paid', $4, $5, $6, 18, $7, $8, $9, now() + interval '10 min')
         RETURNING id`,
        [userId, eventId, categoryId, money.base, money.discount, money.subtotal, money.gst, money.total, ref]
    );
    await pool.query(
        `INSERT INTO tickets (order_id, user_id, event_id, event_ticket_category_id)
         VALUES ($1, $2, $3, $4)`,
        [o.rows[0].id, userId, eventId, categoryId]
    );
    return o.rows[0].id;
}

beforeAll(async () => {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const a = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ($1, $2, 'RevCat Admin', 'administrative') RETURNING id`,
        [ADMIN_EMAIL, hash]
    );
    adminId = a.rows[0].id;
    adminToken = (await request(app).post('/admin/auth/login')
        .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).body.token;

    for (const phone of PHONES) {
        await request(app).post('/auth/login').send({ phone });
        const u = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
        users.push(u.rows[0].id);
    }

    for (const n of ['Single', 'Couple']) {
        const r = await pool.query('INSERT INTO ticket_categories (name) VALUES ($1) RETURNING id', [P + n]);
        catalogIds[n] = r.rows[0].id;
    }

    const ev = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size)
         VALUES ('RevCat Event', 'club', 'del', now() + interval '20 days', 0, 3) RETURNING id`
    );
    eventId = ev.rows[0].id;

    const mk = async (name, price, admits, qty) => (await pool.query(
        `INSERT INTO event_ticket_categories (event_id, category_id, price_paise, admits_count, ticket_quantity)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [eventId, catalogIds[name], price, admits, qty]
    )).rows[0].id;

    cat.Single = await mk('Single', SINGLE.base, 1, 20);
    cat.Couple = await mk('Couple', COUPLE.base, 2, 20);

    // Two Single sales, one Couple sale, and one refunded Couple.
    await seedPaidSale(users[0], cat.Single, SINGLE, 'order_revcat_s1');
    await seedPaidSale(users[1], cat.Single, SINGLE, 'order_revcat_s2');
    await seedPaidSale(users[2], cat.Couple, COUPLE, 'order_revcat_c1');

    await pool.query(
        `INSERT INTO orders (user_id, event_id, event_ticket_category_id, status,
                             base_price_paise, discount_paise, subtotal_paise,
                             gst_percentage, gst_paise, total_paise, razorpay_order_id, expires_at)
         VALUES ($1, $2, $3, 'refunded', $4, $5, $6, 18, $7, $8, 'order_revcat_refund', now() + interval '10 min')`,
        [users[3], eventId, cat.Couple, COUPLE.base, COUPLE.discount, COUPLE.subtotal, COUPLE.gst, COUPLE.total]
    );
});

afterAll(async () => {
    await pool.query('DELETE FROM tickets WHERE event_id = $1', [eventId]);
    await pool.query('DELETE FROM orders WHERE event_id = $1', [eventId]);
    await pool.query('DELETE FROM event_ticket_categories WHERE event_id = $1', [eventId]);
    await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
    await pool.query('DELETE FROM ticket_categories WHERE name LIKE $1', [P + '%']);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [users]);
    await pool.query('DELETE FROM admins WHERE id = $1', [adminId]);
    await pool.end();
});

describe('GET /admin/revenue/by-category', () => {

    const fetch = () => request(app)
        .get(`/admin/revenue/by-category?eventId=${eventId}`)
        .set('Authorization', `Bearer ${adminToken}`);

    it('reports each tier against the seeded values', async () => {
        const res = await fetch();
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(2);

        const single = res.body.data.find(r => r.categoryName === P + 'Single');
        const couple = res.body.data.find(r => r.categoryName === P + 'Couple');

        // Two Single sales at 40000 base, no discount.
        expect(single.ticketsSold).toBe(2);
        expect(single.grossPaise).toBe(2 * SINGLE.base);
        expect(single.discountsPaise).toBe(0);
        expect(single.netBeforeGstPaise).toBe(2 * SINGLE.subtotal);
        expect(single.gstCollectedPaise).toBe(2 * SINGLE.gst);
        expect(single.totalCollectedPaise).toBe(2 * SINGLE.total);
        expect(single.paidOrderCount).toBe(2);

        // One paid Couple sale; the refunded one is NOT in the collected figures.
        expect(couple.ticketsSold).toBe(1);
        expect(couple.grossPaise).toBe(COUPLE.base);
        expect(couple.discountsPaise).toBe(COUPLE.discount);
        expect(couple.totalCollectedPaise).toBe(COUPLE.total);
        expect(couple.paidOrderCount).toBe(1);
    });

    it('holds the money identities per tier', async () => {
        const res = await fetch();
        for (const row of res.body.data) {
            expect(row.grossPaise - row.discountsPaise).toBe(row.netBeforeGstPaise);
            expect(row.netBeforeGstPaise + row.gstCollectedPaise).toBe(row.totalCollectedPaise);
        }
    });

    it('counts people, not tickets, for admits>1 tiers', async () => {
        const res = await fetch();
        const single = res.body.data.find(r => r.categoryName === P + 'Single');
        const couple = res.body.data.find(r => r.categoryName === P + 'Couple');

        expect(single.admitsCount).toBe(1);
        expect(single.peopleAdmitted).toBe(2);      // 2 tickets × 1
        expect(couple.admitsCount).toBe(2);
        expect(couple.peopleAdmitted).toBe(2);      // 1 ticket × 2 — same headcount, half the tickets
    });

    it('surfaces refunds separately rather than netting them', async () => {
        const res = await fetch();
        const couple = res.body.data.find(r => r.categoryName === P + 'Couple');

        expect(couple.refundedPaise).toBe(COUPLE.total);
        // Collected is untouched by the refund.
        expect(couple.totalCollectedPaise).toBe(COUPLE.total);
    });

    // Repricing must not restate history — the frozen order columns are the source.
    it('does not move historical revenue when the tier is repriced', async () => {
        const before = await fetch();
        const coupleBefore = before.body.data.find(r => r.categoryName === P + 'Couple');

        await pool.query('UPDATE event_ticket_categories SET price_paise = 999999 WHERE id = $1', [cat.Couple]);

        const after = await fetch();
        const coupleAfter = after.body.data.find(r => r.categoryName === P + 'Couple');

        expect(coupleAfter.grossPaise).toBe(coupleBefore.grossPaise);
        expect(coupleAfter.totalCollectedPaise).toBe(coupleBefore.totalCollectedPaise);
        // Only the context field moves.
        expect(coupleAfter.currentPricePaise).toBe(999999);

        await pool.query('UPDATE event_ticket_categories SET price_paise = $1 WHERE id = $2', [COUPLE.base, cat.Couple]);
    });

    it('per-tier collections sum to the event total', async () => {
        const byCategory = await fetch();
        const summed = byCategory.body.data.reduce((n, r) => n + r.totalCollectedPaise, 0);

        const byEvent = await request(app)
            .get('/admin/revenue/by-event?limit=100')
            .set('Authorization', `Bearer ${adminToken}`);
        const thisEvent = byEvent.body.data.find(e => e.eventId === eventId);

        expect(summed).toBe(thisEvent.totalCollectedPaise);
    });

    it('requires an admin token', async () => {
        const res = await request(app).get('/admin/revenue/by-category');
        expect(res.status).toBe(401);
    });

});
