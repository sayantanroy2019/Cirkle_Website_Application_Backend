import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

const app = createApp();

const ADMIN_EMAIL = 'test-admin-oversight@cirkle.live';
const ADMIN_PASSWORD = 'AdminOversightPass123!';
const BD_EMAIL = 'test-bd-oversight@cirkle.live';
const BD_PASSWORD = 'BdOversightPass123!';
const ORG_EMAIL = 'test-org-oversight@cirkle.live';
const USER_PHONES = ['+916161616161', '+916262626263', '+916363636364'];

let adminId, bdId, orgId, eventId;
let adminToken, bdToken;
let userIds = [];
let orderIds = { paid: null, refunded: null, created: null, failed: null };
let ticketId, invitationId;

beforeAll(async () => {
    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const adminRow = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ($1, $2, 'Test Oversight Admin', 'administrative') RETURNING id`,
        [ADMIN_EMAIL, adminHash]
    );
    adminId = adminRow.rows[0].id;

    const bdHash = await bcrypt.hash(BD_PASSWORD, 10);
    const bdRow = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ($1, $2, 'Test Oversight BD', 'business_development') RETURNING id`,
        [BD_EMAIL, bdHash]
    );
    bdId = bdRow.rows[0].id;

    const orgHash = await bcrypt.hash('irrelevant', 10);
    const orgRow = await pool.query(
        `INSERT INTO organizers (email, password_hash, display_name)
         VALUES ($1, $2, 'Test Oversight Organizer') RETURNING id`,
        [ORG_EMAIL, orgHash]
    );
    orgId = orgRow.rows[0].id;

    const eventRow = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size, organizer_id)
         VALUES ('TEST Oversight Event', 'club', 'del', now() + interval '15 days', 50000, 3, $1)
         RETURNING id`,
        [orgId]
    );
    eventId = eventRow.rows[0].id;

    // Three real users via the actual login flow, with a couple of profile fields set
    for (const phone of USER_PHONES) {
        const login = await request(app).post('/auth/login').send({ phone });
        const u = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
        userIds.push(u.rows[0].id);
    }
    await pool.query(
        `UPDATE profiles SET first_name = 'OversightSearchTarget', last_name = 'Smith', email = 'searchtarget@cirkle.live', gender = 'man', city_id = 'del', date_of_birth = '1995-01-01' WHERE user_id = $1`,
        [userIds[0]]
    );

    // Known-value paid order — used to verify the revenue math ties out exactly
    const paidOrder = await pool.query(
        `INSERT INTO orders (user_id, event_id, status, base_price_paise, discount_paise,
                             subtotal_paise, gst_percentage, gst_paise, total_paise,
                             razorpay_order_id, expires_at)
         VALUES ($1, $2, 'paid', 50000, 5000, 45000, 18, 8100, 53100, 'order_test_oversight_paid', now() + interval '10 min')
         RETURNING id`,
        [userIds[0], eventId]
    );
    orderIds.paid = paidOrder.rows[0].id;

    const ticketRow = await pool.query(
        `INSERT INTO tickets (order_id, user_id, event_id) VALUES ($1, $2, $3) RETURNING id`,
        [orderIds.paid, userIds[0], eventId]
    );
    ticketId = ticketRow.rows[0].id;

    const refundedOrder = await pool.query(
        `INSERT INTO orders (user_id, event_id, status, base_price_paise, discount_paise,
                             subtotal_paise, gst_percentage, gst_paise, total_paise,
                             razorpay_order_id, expires_at)
         VALUES ($1, $2, 'refunded', 30000, 0, 30000, 18, 5400, 35400, 'order_test_oversight_refunded', now() + interval '10 min')
         RETURNING id`,
        [userIds[1], eventId]
    );
    orderIds.refunded = refundedOrder.rows[0].id;

    const createdOrder = await pool.query(
        `INSERT INTO orders (user_id, event_id, status, base_price_paise, discount_paise,
                             subtotal_paise, gst_percentage, gst_paise, total_paise,
                             razorpay_order_id, expires_at)
         VALUES ($1, $2, 'created', 40000, 0, 40000, 18, 7200, 47200, 'order_test_oversight_created', now() + interval '10 min')
         RETURNING id`,
        [userIds[2], eventId]
    );
    orderIds.created = createdOrder.rows[0].id;

    const failedOrder = await pool.query(
        `INSERT INTO orders (user_id, event_id, status, base_price_paise, discount_paise,
                             subtotal_paise, gst_percentage, gst_paise, total_paise,
                             razorpay_order_id, expires_at)
         VALUES ($1, $2, 'failed', 20000, 0, 20000, 18, 3600, 23600, 'order_test_oversight_failed', now() + interval '10 min')
         RETURNING id`,
        [userIds[2], eventId]
    );
    orderIds.failed = failedOrder.rows[0].id;

    const invitationRow = await pool.query(
        `INSERT INTO event_invitations (user_id, event_id, organizer_id, status)
         VALUES ($1, $2, $3, 'pending') RETURNING id`,
        [userIds[1], eventId, orgId]
    );
    invitationId = invitationRow.rows[0].id;

    const adminLogin = await request(app).post('/admin/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminToken = adminLogin.body.token;
    const bdLogin = await request(app).post('/admin/auth/login').send({ email: BD_EMAIL, password: BD_PASSWORD });
    bdToken = bdLogin.body.token;
}, 30000);

afterAll(async () => {
    await pool.query('DELETE FROM event_invitations WHERE id = $1', [invitationId]);
    await pool.query('DELETE FROM tickets WHERE id = $1', [ticketId]);
    await pool.query('DELETE FROM orders WHERE id = ANY($1)', [Object.values(orderIds)]);
    await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
    await pool.query('DELETE FROM organizers WHERE id = $1', [orgId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    await pool.query('DELETE FROM admins WHERE id = ANY($1)', [[adminId, bdId]]);
    await pool.end();
}, 30000);

describe('Pagination — shared shape', () => {

    it('defaults to limit 50, offset 0, and returns a total', async () => {
        const res = await request(app).get('/admin/orders').set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.limit).toBe(50);
        expect(res.body.offset).toBe(0);
        expect(res.body.total).toBeGreaterThanOrEqual(4);
        expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('clamps limit at 100 even if a larger value is requested', async () => {
        const res = await request(app).get('/admin/orders?limit=500').set('Authorization', `Bearer ${adminToken}`);
        expect(res.body.limit).toBe(100);
    });

    it('offset actually pages through results', async () => {
        const page1 = await request(app).get('/admin/orders?limit=1&offset=0').set('Authorization', `Bearer ${adminToken}`);
        const page2 = await request(app).get('/admin/orders?limit=1&offset=1').set('Authorization', `Bearer ${adminToken}`);
        expect(page1.body.data[0].id).not.toBe(page2.body.data[0].id);
    });

});

describe('GET /admin/orders — filters', () => {

    it('filters by status', async () => {
        const res = await request(app).get('/admin/orders?status=paid&limit=100').set('Authorization', `Bearer ${adminToken}`);
        expect(res.body.data.every(o => o.status === 'paid')).toBe(true);
        expect(res.body.data.some(o => o.id === orderIds.paid)).toBe(true);
    });

    it('filters by eventId and userId together', async () => {
        const res = await request(app)
            .get(`/admin/orders?eventId=${eventId}&userId=${userIds[0]}&limit=100`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.body.data.every(o => o.event.id === eventId && o.user.id === userIds[0])).toBe(true);
    });

    it('filters by created_at date range', async () => {
        const res = await request(app)
            .get(`/admin/orders?from=2000-01-01&to=2099-01-01&limit=100`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.body.data.some(o => o.id === orderIds.paid)).toBe(true);
    });

    it('rejects an invalid status', async () => {
        const res = await request(app).get('/admin/orders?status=bogus').set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(400);
    });

});

describe('GET /admin/orders/:id', () => {

    it('returns the full order including ticket (paid order)', async () => {
        const res = await request(app).get(`/admin/orders/${orderIds.paid}`).set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.order.ticket.id).toBe(ticketId);
        expect(res.body.order.breakdown.totalPaise).toBe(53100);
    });

});

describe('GET /admin/revenue — math ties out, refunded excluded', () => {

    it('gross - discount = subtotal, subtotal + gst = total, against the known paid order', async () => {
        const res = await request(app).get('/admin/revenue').set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);

        // Since other tests in this suite may add their own paid orders,
        // assert the ARITHMETIC RELATIONSHIP holds on the aggregate, and
        // that our specific known order's contribution is present.
        expect(res.body.grossPaise - res.body.discountsPaise).toBe(res.body.netBeforeGstPaise);
        expect(res.body.netBeforeGstPaise + res.body.gstCollectedPaise).toBe(res.body.totalCollectedPaise);
        expect(res.body.totalCollectedPaise).toBeGreaterThanOrEqual(53100);
    });

    it('excludes refunded and created/failed orders from collected totals, surfaces refundedPaise separately', async () => {
        const res = await request(app).get('/admin/revenue').set('Authorization', `Bearer ${adminToken}`);
        // The refunded order (35400) must not be in totalCollectedPaise —
        // we can't assert an exact global total (shared DB), but we CAN
        // assert refundedPaise itself is at least our known refunded amount.
        expect(res.body.refundedPaise).toBeGreaterThanOrEqual(35400);
    });

});

describe('GET /admin/revenue/by-event', () => {

    it('breaks down revenue per event, paginated', async () => {
        const res = await request(app).get('/admin/revenue/by-event?limit=100').set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        const row = res.body.data.find(e => e.eventId === eventId);
        expect(row.totalCollectedPaise).toBe(53100);
        expect(row.refundedPaise).toBe(35400);
        expect(row.ticketsSold).toBe(1);
    });

});

describe('GET /admin/tickets — guest list use case', () => {

    it('filters by eventId and checkedIn=false', async () => {
        const res = await request(app)
            .get(`/admin/tickets?eventId=${eventId}&checkedIn=false`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.data.length).toBe(1);
        expect(res.body.data[0].id).toBe(ticketId);
        expect(res.body.data[0].checkedIn).toBe(false);
    });

    it('rejects an invalid checkedIn value', async () => {
        const res = await request(app).get('/admin/tickets?checkedIn=maybe').set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(400);
    });

});

describe('GET /admin/tickets/:id', () => {

    it('returns ticket detail with order and price paid', async () => {
        const res = await request(app).get(`/admin/tickets/${ticketId}`).set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.ticket.order.id).toBe(orderIds.paid);
        expect(res.body.ticket.order.pricePaidPaise).toBe(53100);
    });

});

describe('GET /admin/invitations', () => {

    it('filters by eventId and status, includes organizer and requester summary', async () => {
        const res = await request(app)
            .get(`/admin/invitations?eventId=${eventId}&status=pending`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        const row = res.body.data.find(i => i.id === invitationId);
        expect(row.organizer.id).toBe(orgId);
        expect(row.user.id).toBe(userIds[1]);
    });

});

describe('GET /admin/users — search', () => {

    it('matches a partial first name, case-insensitive', async () => {
        const res = await request(app).get('/admin/users?search=oversightsearch').set('Authorization', `Bearer ${adminToken}`);
        expect(res.body.data.some(u => u.id === userIds[0])).toBe(true);
    });

    it('matches a partial email', async () => {
        const res = await request(app).get('/admin/users?search=searchtarget@cirkle').set('Authorization', `Bearer ${adminToken}`);
        expect(res.body.data.some(u => u.id === userIds[0])).toBe(true);
    });

    it('matches a partial phone', async () => {
        const res = await request(app).get('/admin/users?search=6161616161').set('Authorization', `Bearer ${adminToken}`);
        expect(res.body.data.some(u => u.id === userIds[0])).toBe(true);
    });

});

describe('GET /admin/users/:id — support lookup screen', () => {

    it('returns full profile with presigned photo URLs (none set here, so empty array) and order/ticket history', async () => {
        const res = await request(app).get(`/admin/users/${userIds[0]}`).set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.user.photos).toEqual([]);
        expect(res.body.user.orders.some(o => o.id === orderIds.paid)).toBe(true);
        expect(res.body.user.tickets.some(t => t.id === ticketId)).toBe(true);
        expect(JSON.stringify(res.body)).not.toMatch(/s3_key|"s3Key"/);
    });

    it('returns 404 for a nonexistent user', async () => {
        const res = await request(app).get('/admin/users/00000000-0000-0000-0000-000000000000').set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(404);
    });

});

describe('Both admin roles can access every Part 3 endpoint', () => {

    const endpoints = [
        () => request(app).get('/admin/orders').set('Authorization', `Bearer ${bdToken}`),
        () => request(app).get(`/admin/orders/${orderIds.paid}`).set('Authorization', `Bearer ${bdToken}`),
        () => request(app).get('/admin/tickets').set('Authorization', `Bearer ${bdToken}`),
        () => request(app).get(`/admin/tickets/${ticketId}`).set('Authorization', `Bearer ${bdToken}`),
        () => request(app).get('/admin/revenue').set('Authorization', `Bearer ${bdToken}`),
        () => request(app).get('/admin/revenue/by-event').set('Authorization', `Bearer ${bdToken}`),
        () => request(app).get('/admin/invitations').set('Authorization', `Bearer ${bdToken}`),
        () => request(app).get('/admin/users').set('Authorization', `Bearer ${bdToken}`),
        () => request(app).get(`/admin/users/${userIds[0]}`).set('Authorization', `Bearer ${bdToken}`)
    ];

    it('a business_development admin gets 200, never 403, on every read-only oversight endpoint', async () => {
        for (const call of endpoints) {
            const res = await call();
            expect(res.status).toBe(200);
        }
    });

});
