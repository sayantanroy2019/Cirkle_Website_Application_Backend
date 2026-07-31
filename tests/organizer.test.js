import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

const app = createApp();

const ORG_A_EMAIL = 'test-org-a-dashboard@cirkle.live';
const ORG_A_PASSWORD = 'OrgADashPass123!';
const ORG_B_EMAIL = 'test-org-b-dashboard@cirkle.live';
const ORG_B_PASSWORD = 'OrgBDashPass123!';

// Distinctive, greppable PII values — if either ever shows up in an
// organizer-facing response, the leak test below will catch it.
const ATTENDEE_PHONE = '+916464646465';
const ATTENDEE_EMAIL = 'must-never-leak-to-organizer@cirkle.live';
const REQUESTER_PHONE = '+916565656566';

let orgAId, orgBId, orgAToken, orgBToken;
let eventAId, eventBId;
let attendeeUserId, requesterUserId;
let ticketId, pendingInvitationId, decidedInvitationId;
let userToken, adminToken, adminId;

beforeAll(async () => {
    const orgAHash = await bcrypt.hash(ORG_A_PASSWORD, 10);
    const orgARow = await pool.query(
        `INSERT INTO organizers (email, password_hash, display_name) VALUES ($1, $2, 'Org A') RETURNING id`,
        [ORG_A_EMAIL, orgAHash]
    );
    orgAId = orgARow.rows[0].id;

    const orgBHash = await bcrypt.hash(ORG_B_PASSWORD, 10);
    const orgBRow = await pool.query(
        `INSERT INTO organizers (email, password_hash, display_name) VALUES ($1, $2, 'Org B') RETURNING id`,
        [ORG_B_EMAIL, orgBHash]
    );
    orgBId = orgBRow.rows[0].id;

    const eventA = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size, event_type, capacity, organizer_id)
         VALUES ('TEST Org Dashboard Event A', 'club', 'del', now() + interval '20 days', 50000, 3, 'invite_only', 10, $1)
         RETURNING id`,
        [orgAId]
    );
    eventAId = eventA.rows[0].id;

    const eventB = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size, organizer_id)
         VALUES ('TEST Org Dashboard Event B', 'club', 'del', now() + interval '20 days', 50000, 3, $1)
         RETURNING id`,
        [orgBId]
    );
    eventBId = eventB.rows[0].id;

    // Attendee (has a ticket) — profile carries the greppable phone/email
    const attendeeLogin = await request(app).post('/auth/login').send({ phone: ATTENDEE_PHONE });
    userToken = attendeeLogin.body.token; // reused later for the token-separation test
    const attendeeUser = await pool.query('SELECT id FROM users WHERE phone = $1', [ATTENDEE_PHONE]);
    attendeeUserId = attendeeUser.rows[0].id;
    await pool.query(
        `UPDATE profiles SET first_name = 'Attendee', last_name = 'Person', gender = 'woman',
                             date_of_birth = '1997-06-01', email = $2, bio = 'test bio', tagline = 'test tagline'
         WHERE user_id = $1`,
        [attendeeUserId, ATTENDEE_EMAIL]
    );

    const paidOrder = await pool.query(
        `INSERT INTO orders (user_id, event_id, status, base_price_paise, discount_paise,
                             subtotal_paise, gst_percentage, gst_paise, total_paise,
                             razorpay_order_id, expires_at)
         VALUES ($1, $2, 'paid', 50000, 0, 50000, 18, 9000, 59000, 'order_test_org_dashboard', now() + interval '10 min')
         RETURNING id`,
        [attendeeUserId, eventAId]
    );
    const ticketRow = await pool.query(
        `INSERT INTO tickets (order_id, user_id, event_id) VALUES ($1, $2, $3) RETURNING id`,
        [paidOrder.rows[0].id, attendeeUserId, eventAId]
    );
    ticketId = ticketRow.rows[0].id;

    // Requester (pending invitation) — also carries a greppable phone
    const requesterLogin = await request(app).post('/auth/login').send({ phone: REQUESTER_PHONE });
    const requesterUser = await pool.query('SELECT id FROM users WHERE phone = $1', [REQUESTER_PHONE]);
    requesterUserId = requesterUser.rows[0].id;
    await pool.query(
        `UPDATE profiles SET first_name = 'Requester', last_name = 'Person', gender = 'man', date_of_birth = '1996-01-01'
         WHERE user_id = $1`,
        [requesterUserId]
    );

    const pendingInv = await pool.query(
        `INSERT INTO event_invitations (user_id, event_id, organizer_id, status)
         VALUES ($1, $2, $3, 'pending') RETURNING id`,
        [requesterUserId, eventAId, orgAId]
    );
    pendingInvitationId = pendingInv.rows[0].id;

    // A second, already-decided invitation for the 409 test
    const decidedInv = await pool.query(
        `INSERT INTO event_invitations (user_id, event_id, organizer_id, status)
         VALUES ($1, $2, $3, 'rejected') RETURNING id`,
        [attendeeUserId, eventBId, orgBId]
    );
    decidedInvitationId = decidedInv.rows[0].id;

    const orgALogin = await request(app).post('/organizer/auth/login').send({ email: ORG_A_EMAIL, password: ORG_A_PASSWORD });
    orgAToken = orgALogin.body.token;
    const orgBLogin = await request(app).post('/organizer/auth/login').send({ email: ORG_B_EMAIL, password: ORG_B_PASSWORD });
    orgBToken = orgBLogin.body.token;

    const adminHash = await bcrypt.hash('irrelevant-admin-pass', 10);
    const adminRow = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ('test-admin-for-org-dash@cirkle.live', $1, 'x', 'administrative') RETURNING id`,
        [adminHash]
    );
    adminId = adminRow.rows[0].id;
    const adminLogin = await request(app).post('/admin/auth/login').send({ email: 'test-admin-for-org-dash@cirkle.live', password: 'irrelevant-admin-pass' });
    adminToken = adminLogin.body.token;
}, 30000);

afterAll(async () => {
    await pool.query('DELETE FROM event_invitations WHERE id = ANY($1)', [[pendingInvitationId, decidedInvitationId]]);
    await pool.query('DELETE FROM tickets WHERE id = $1', [ticketId]);
    await pool.query('DELETE FROM orders WHERE event_id = ANY($1)', [[eventAId, eventBId]]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [[eventAId, eventBId]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[attendeeUserId, requesterUserId]]);
    await pool.query('DELETE FROM organizers WHERE id = ANY($1)', [[orgAId, orgBId]]);
    await pool.query('DELETE FROM admins WHERE id = $1', [adminId]);
    await pool.end();
}, 30000);

describe('POST /organizer/auth/login', () => {

    it('works with valid credentials and returns an ORGANIZER_JWT_SECRET token', async () => {
        const res = await request(app).post('/organizer/auth/login').send({ email: ORG_A_EMAIL, password: ORG_A_PASSWORD });
        expect(res.status).toBe(200);
        expect(res.body.token).toBeDefined();
        expect(res.body.organizer.email).toBe(ORG_A_EMAIL);
        expect(JSON.stringify(res.body)).not.toMatch(/password_hash/);
    });

    it('returns a generic 401 for wrong password', async () => {
        const res = await request(app).post('/organizer/auth/login').send({ email: ORG_A_EMAIL, password: 'wrong' });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Invalid credentials');
    });

    it('returns the SAME generic 401 for an unknown email', async () => {
        const res = await request(app).post('/organizer/auth/login').send({ email: 'nobody@cirkle.live', password: 'whatever123' });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Invalid credentials');
    });

});

describe('Token separation — all crossings', () => {

    it('rejects a user (attendee) token on an organizer route', async () => {
        const res = await request(app).get('/organizer/events').set('Authorization', `Bearer ${userToken}`);
        expect(res.status).toBe(401);
    });

    it('rejects an admin token on an organizer route', async () => {
        const res = await request(app).get('/organizer/events').set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(401);
    });

    it('rejects an organizer token on a user route', async () => {
        const res = await request(app).get('/profile/me').set('Authorization', `Bearer ${orgAToken}`);
        expect(res.status).toBe(401);
    });

    it('rejects an organizer token on an admin route', async () => {
        const res = await request(app).get('/admin/orders').set('Authorization', `Bearer ${orgAToken}`);
        expect(res.status).toBe(401);
    });

});

describe('Deactivation stops an existing organizer token immediately', () => {

    it('a deactivated organizer cannot use their existing token', async () => {
        await pool.query('UPDATE organizers SET is_active = false WHERE id = $1', [orgBId]);

        const res = await request(app).get('/organizer/events').set('Authorization', `Bearer ${orgBToken}`);
        expect(res.status).toBe(401);

        // Reactivate for the rest of the suite (org B is used below)
        await pool.query('UPDATE organizers SET is_active = true WHERE id = $1', [orgBId]);
        const relogin = await request(app).post('/organizer/auth/login').send({ email: ORG_B_EMAIL, password: ORG_B_PASSWORD });
        orgBToken = relogin.body.token;
    });

});

describe('GET /organizer/events — scoping', () => {

    it('returns ONLY the logged-in organizer\'s events', async () => {
        const res = await request(app).get('/organizer/events').set('Authorization', `Bearer ${orgAToken}`);
        expect(res.status).toBe(200);
        expect(res.body.data.some(e => e.id === eventAId)).toBe(true);
        expect(res.body.data.some(e => e.id === eventBId)).toBe(false);
    });

});

describe('Ownership — requesting another organizer\'s data returns 404, never data', () => {

    it('GET /organizer/events/:id for another organizer\'s event -> 404', async () => {
        const res = await request(app).get(`/organizer/events/${eventBId}`).set('Authorization', `Bearer ${orgAToken}`);
        expect(res.status).toBe(404);
    });

    it('GET /organizer/events/:id/attendees for another organizer\'s event -> 404', async () => {
        const res = await request(app).get(`/organizer/events/${eventBId}/attendees`).set('Authorization', `Bearer ${orgAToken}`);
        expect(res.status).toBe(404);
    });

    it('GET /organizer/events/:id/invitations for another organizer\'s event -> 404', async () => {
        const res = await request(app).get(`/organizer/events/${eventBId}/invitations`).set('Authorization', `Bearer ${orgAToken}`);
        expect(res.status).toBe(404);
    });

});

describe('GET /organizer/events/:id — detail and gross sales', () => {

    it('returns full detail with gross sales matching the sum of paid orders', async () => {
        const res = await request(app).get(`/organizer/events/${eventAId}`).set('Authorization', `Bearer ${orgAToken}`);
        expect(res.status).toBe(200);
        expect(res.body.event.ticketsSold).toBe(1);
        expect(res.body.event.grossSalesPaise).toBe(59000);
    });

});

describe('GET /organizer/events/:id/attendees — PII leak test (the highest-risk check)', () => {

    it('includes presigned photo URLs and check-in status, and the raw response text contains NEITHER the phone NOR the email', async () => {
        const res = await request(app).get(`/organizer/events/${eventAId}/attendees`).set('Authorization', `Bearer ${orgAToken}`);
        expect(res.status).toBe(200);

        const card = res.body.data.find(a => a.userId === attendeeUserId);
        expect(card).toBeDefined();
        expect(card.checkedIn).toBe(false);
        expect(card.firstName).toBe('Attendee');
        expect(Array.isArray(card.photos)).toBe(true);

        // The actual grep check, run against the raw response body — not
        // eyeballed. Must not contain the literal phone or email, nor the
        // field names that would carry them.
        const raw = JSON.stringify(res.body);
        expect(raw).not.toContain(ATTENDEE_PHONE);
        expect(raw).not.toContain(ATTENDEE_EMAIL);
        expect(raw).not.toMatch(/"phone"|"email"/);
    });

});

describe('GET /organizer/events/:id/invitations — PII leak test', () => {

    it('returns the pending requester as a profile card with no phone/email anywhere', async () => {
        const res = await request(app).get(`/organizer/events/${eventAId}/invitations`).set('Authorization', `Bearer ${orgAToken}`);
        expect(res.status).toBe(200);

        const card = res.body.data.find(i => i.invitationId === pendingInvitationId);
        expect(card).toBeDefined();
        expect(card.status).toBe('pending');
        expect(card.firstName).toBe('Requester');

        const raw = JSON.stringify(res.body);
        expect(raw).not.toContain(REQUESTER_PHONE);
        expect(raw).not.toMatch(/"phone"|"email"/);
    });

    it('defaults to status=pending when no filter is given', async () => {
        const res = await request(app).get(`/organizer/events/${eventAId}/invitations`).set('Authorization', `Bearer ${orgAToken}`);
        expect(res.body.data.every(i => i.status === 'pending')).toBe(true);
    });

});

describe('POST /organizer/invitations/:invitationId/decision', () => {

    it('org A cannot decide on an invitation belonging to org B (404, not 403)', async () => {
        const res = await request(app)
            .post(`/organizer/invitations/${decidedInvitationId}/decision`)
            .set('Authorization', `Bearer ${orgAToken}`)
            .send({ decision: 'accept' });
        expect(res.status).toBe(404);
    });

    it('409 on an already-decided invitation, terminal state holds', async () => {
        const res = await request(app)
            .post(`/organizer/invitations/${decidedInvitationId}/decision`)
            .set('Authorization', `Bearer ${orgBToken}`)
            .send({ decision: 'accept' });
        expect(res.status).toBe(409);

        // Confirm it's still rejected, not silently flipped
        const check = await pool.query('SELECT status FROM event_invitations WHERE id = $1', [decidedInvitationId]);
        expect(check.rows[0].status).toBe('rejected');
    });

    it('accepts a pending invitation, and the user can then pass the purchase gate', async () => {
        const res = await request(app)
            .post(`/organizer/invitations/${pendingInvitationId}/decision`)
            .set('Authorization', `Bearer ${orgAToken}`)
            .send({ decision: 'accept' });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('accepted');

        // Requester now has an accepted invitation for eventA (invite_only)
        // — the existing consumer gate should let them create an order.
        const requesterLogin = await request(app).post('/auth/login').send({ phone: REQUESTER_PHONE });
        const requesterToken = requesterLogin.body.token;

        const orderRes = await request(app)
            .post('/payments/orders')
            .set('Authorization', `Bearer ${requesterToken}`)
            .send({ eventId: eventAId });
        expect(orderRes.status).toBe(201);

        await pool.query('DELETE FROM orders WHERE user_id = $1 AND event_id = $2', [requesterUserId, eventAId]);
    });

    it('deciding again on the now-accepted invitation returns 409', async () => {
        const res = await request(app)
            .post(`/organizer/invitations/${pendingInvitationId}/decision`)
            .set('Authorization', `Bearer ${orgAToken}`)
            .send({ decision: 'reject' });
        expect(res.status).toBe(409);
    });

    it('rejects an invalid decision value', async () => {
        const res = await request(app)
            .post(`/organizer/invitations/${pendingInvitationId}/decision`)
            .set('Authorization', `Bearer ${orgAToken}`)
            .send({ decision: 'maybe' });
        expect(res.status).toBe(400);
    });

});
