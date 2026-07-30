import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

const app = createApp();

const ADMIN_EMAIL = 'test-admin-events@cirkle.live';
const ADMIN_PASSWORD = 'AdminEventsPass123!';
const BD_EMAIL = 'test-bd-events@cirkle.live';
const BD_PASSWORD = 'BdEventsPass123!';
const ORG_EMAIL = 'test-org-events@cirkle.live';

let adminId, bdId, orgId, adminToken, bdToken;
const createdEventIds = [];

async function uploadTestImage(eventId, kind = 'gallery', contentType = 'image/jpeg') {
    const urlRes = await request(app)
        .post(`/admin/events/${eventId}/image-url`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contentType, kind });
    const { uploadUrl, key } = urlRes.body;

    await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: Buffer.from('test-event-image-bytes')
    });

    return key;
}

beforeAll(async () => {
    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const adminRow = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ($1, $2, 'Test Events Admin', 'administrative') RETURNING id`,
        [ADMIN_EMAIL, adminHash]
    );
    adminId = adminRow.rows[0].id;

    const bdHash = await bcrypt.hash(BD_PASSWORD, 10);
    const bdRow = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ($1, $2, 'Test Events BD', 'business_development') RETURNING id`,
        [BD_EMAIL, bdHash]
    );
    bdId = bdRow.rows[0].id;

    const orgHash = await bcrypt.hash('irrelevant-not-tested-here', 10);
    const orgRow = await pool.query(
        `INSERT INTO organizers (email, password_hash, display_name)
         VALUES ($1, $2, 'Test Events Organizer') RETURNING id`,
        [ORG_EMAIL, orgHash]
    );
    orgId = orgRow.rows[0].id;

    const adminLogin = await request(app).post('/admin/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminToken = adminLogin.body.token;
    const bdLogin = await request(app).post('/admin/auth/login').send({ email: BD_EMAIL, password: BD_PASSWORD });
    bdToken = bdLogin.body.token;
}, 30000);

afterAll(async () => {
    await pool.query('DELETE FROM audit_log WHERE entity_type = $1 AND entity_id = ANY($2)', ['event', createdEventIds]);
    await pool.query('DELETE FROM event_photos WHERE event_id = ANY($1)', [createdEventIds]);
    await pool.query('DELETE FROM orders WHERE event_id = ANY($1)', [createdEventIds]);
    await pool.query('DELETE FROM tickets WHERE event_id = ANY($1)', [createdEventIds]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [createdEventIds]);
    await pool.query('DELETE FROM organizers WHERE id = $1', [orgId]);
    await pool.query('DELETE FROM admins WHERE id = ANY($1)', [[adminId, bdId]]);
    await pool.end();
}, 30000);

describe('POST /admin/events', () => {

    it('creates an event, returns its id, and writes an audit row', async () => {
        const res = await request(app)
            .post('/admin/events')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                name: 'Test Suite Event',
                categoryId: 'club',
                cityId: 'del',
                startsAt: new Date(Date.now() + 30 * 86400000).toISOString(),
                price: 50000,
                targetGroupSize: 3,
                organizerId: orgId
            });

        expect(res.status).toBe(201);
        expect(res.body.event.id).toBeDefined();
        expect(res.body.event.organizerId).toBe(orgId);
        createdEventIds.push(res.body.event.id);

        const auditRes = await pool.query(
            `SELECT action, admin_id FROM audit_log WHERE entity_type = 'event' AND entity_id = $1`,
            [res.body.event.id]
        );
        expect(auditRes.rows.length).toBe(1);
        expect(auditRes.rows[0].action).toBe('create');
    });

    it('a business_development admin can also create an event', async () => {
        const res = await request(app)
            .post('/admin/events')
            .set('Authorization', `Bearer ${bdToken}`)
            .send({
                name: 'Test Suite BD Event',
                categoryId: 'concert',
                cityId: 'del',
                startsAt: new Date(Date.now() + 30 * 86400000).toISOString(),
                price: 30000,
                targetGroupSize: 2
            });
        expect(res.status).toBe(201);
        createdEventIds.push(res.body.event.id);
    });

    it('rejects a startsAt in the past', async () => {
        const res = await request(app)
            .post('/admin/events')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                name: 'Bad Event',
                categoryId: 'club',
                cityId: 'del',
                startsAt: new Date(Date.now() - 86400000).toISOString(),
                price: 10000,
                targetGroupSize: 2
            });
        expect(res.status).toBe(400);
    });

    it('rejects an invalid categoryId', async () => {
        const res = await request(app)
            .post('/admin/events')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                name: 'Bad Category Event',
                categoryId: 'not-a-real-category',
                cityId: 'del',
                startsAt: new Date(Date.now() + 86400000).toISOString(),
                price: 10000,
                targetGroupSize: 2
            });
        expect(res.status).toBe(400);
    });

});

describe('GET /admin/events', () => {

    it('lists events, filterable by organizerId', async () => {
        const res = await request(app)
            .get(`/admin/events?organizerId=${orgId}`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.events.every(e => e.organizerId === orgId)).toBe(true);
    });

    it('rejects an invalid status filter', async () => {
        const res = await request(app)
            .get('/admin/events?status=nonsense')
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(400);
    });

});

describe('GET /admin/events/:id', () => {

    it('returns full detail with organizer and empty gallery', async () => {
        const res = await request(app)
            .get(`/admin/events/${createdEventIds[0]}`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.event.organizer.id).toBe(orgId);
        expect(res.body.event.gallery).toEqual([]);
        expect(res.body.event.bannerUrl).toBeNull();
    });

});

describe('PATCH /admin/events/:id — edits and the price-freeze guarantee', () => {

    it('edits the price and records a from/to audit diff', async () => {
        const res = await request(app)
            .patch(`/admin/events/${createdEventIds[0]}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ price: 60000 });
        expect(res.status).toBe(200);
        expect(res.body.event.price).toBe(60000);

        const auditRes = await pool.query(
            `SELECT changes FROM audit_log
             WHERE entity_type = 'event' AND entity_id = $1 AND action = 'update'
             ORDER BY created_at DESC LIMIT 1`,
            [createdEventIds[0]]
        );
        expect(auditRes.rows[0].changes.price).toEqual({ from: 50000, to: 60000 });
    });

    it('editing price after a ticket is sold does NOT change the frozen order/ticket price', async () => {
        // Simulate a completed purchase by direct insert (mirrors what
        // confirmOrderPaid does) — bypasses Razorpay, which isn't under test here.
        const eventId = createdEventIds[0];
        const orderRes = await pool.query(
            `INSERT INTO orders (user_id, event_id, status, base_price_paise, discount_paise,
                                 subtotal_paise, gst_percentage, gst_paise, total_paise,
                                 razorpay_order_id, expires_at)
             SELECT id, $1, 'paid', 60000, 0, 60000, 18, 10800, 70800,
                    'order_test_freeze_check', now() + interval '10 min'
             FROM users LIMIT 1
             RETURNING id, total_paise`,
            [eventId]
        );
        const orderId = orderRes.rows[0].id;
        const frozenTotal = orderRes.rows[0].total_paise;

        // Admin now edits the event's price
        const patchRes = await request(app)
            .patch(`/admin/events/${eventId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ price: 999999 });
        expect(patchRes.status).toBe(200);
        expect(patchRes.body.event.price).toBe(999999);

        // The already-placed order's frozen price must be untouched
        const orderCheck = await pool.query('SELECT total_paise FROM orders WHERE id = $1', [orderId]);
        expect(orderCheck.rows[0].total_paise).toBe(frozenTotal);

        await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
    });

    it('rejects a startsAt in the past when startsAt IS being changed', async () => {
        const res = await request(app)
            .patch(`/admin/events/${createdEventIds[0]}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ startsAt: new Date(Date.now() - 86400000).toISOString() });
        expect(res.status).toBe(400);
    });

    it('allows editing other fields on an already-started event without touching startsAt', async () => {
        // Directly insert a past event as a fixture — the create endpoint
        // itself refuses a past startsAt, by design.
        const pastEvent = await pool.query(
            `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size)
             VALUES ('Test Past Event For Edit', 'club', 'del', now() - interval '2 days', 40000, 2)
             RETURNING id`
        );
        const pastEventId = pastEvent.rows[0].id;
        createdEventIds.push(pastEventId);

        const res = await request(app)
            .patch(`/admin/events/${pastEventId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ venueName: 'Updated Venue Name' });
        expect(res.status).toBe(200);
        expect(res.body.event.venueName).toBe('Updated Venue Name');
    });

});

describe('Event images — banner and gallery', () => {
    let eventId;

    beforeAll(() => {
        eventId = createdEventIds[0];
    });

    it('upload handshake works and objectExists rejects a fake key', async () => {
        const key = await uploadTestImage(eventId, 'banner');

        const bannerRes = await request(app)
            .patch(`/admin/events/${eventId}/banner`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ s3Key: key });
        expect(bannerRes.status).toBe(200);
        expect(bannerRes.body.bannerUrl).toBeDefined();

        const fakeRes = await request(app)
            .patch(`/admin/events/${eventId}/banner`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ s3Key: 'events/fake/banner/nope.jpg' });
        expect(fakeRes.status).toBe(400);
    });

    it('gallery enforces max 5 photos', async () => {
        const res = await request(app)
            .put(`/admin/events/${eventId}/gallery`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ photos: [0, 1, 2, 3, 4, 5].map(position => ({ s3Key: `events/${eventId}/gallery/fake-${position}.jpg`, position })) });
        expect(res.status).toBe(400);
    });

    it('gallery verification is all-or-nothing — one fake key rejects the whole set, nothing saved', async () => {
        const realKey = await uploadTestImage(eventId, 'gallery');

        const res = await request(app)
            .put(`/admin/events/${eventId}/gallery`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ photos: [
                { s3Key: realKey, position: 0 },
                { s3Key: 'events/fake/gallery/nope.jpg', position: 1 }
            ]});
        expect(res.status).toBe(400);

        const dbCheck = await pool.query('SELECT id FROM event_photos WHERE event_id = $1', [eventId]);
        expect(dbCheck.rows.length).toBe(0);
    });

    it('saves a real gallery and returns signed view URLs', async () => {
        const key0 = await uploadTestImage(eventId, 'gallery');
        const key1 = await uploadTestImage(eventId, 'gallery');

        const res = await request(app)
            .put(`/admin/events/${eventId}/gallery`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ photos: [
                { s3Key: key0, position: 0 },
                { s3Key: key1, position: 1 }
            ]});
        expect(res.status).toBe(200);
        expect(res.body.gallery.length).toBe(2);
        expect(res.body.gallery[0].url).toMatch(/^https:\/\//);
    });

    it('the consumer GET /events/:id now returns presigned bannerUrl + gallery, never raw keys', async () => {
        const userLogin = await request(app).post('/auth/login').send({ phone: '+916868686869' });
        const userToken = userLogin.body.token;

        const res = await request(app)
            .get(`/events/${eventId}`)
            .set('Authorization', `Bearer ${userToken}`);
        expect(res.status).toBe(200);
        expect(res.body.event.bannerUrl).toMatch(/^https:\/\//);
        expect(res.body.event.gallery.length).toBe(2);
        expect(res.body.event.gallery[0].url).toMatch(/^https:\/\//);
        expect(JSON.stringify(res.body)).not.toMatch(/s3Key|banner_s3_key|"s3_key"/);

        await pool.query("DELETE FROM users WHERE phone = '+916868686869'");
    });

});
