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

    // Price moved onto ticket categories in Part 4, so the guarantee is now
    // "repricing a CATEGORY doesn't restate orders already placed against it".
    // Same principle, new source: the order froze what it charged.
    it('repricing a category does not change an order already frozen against it', async () => {
        const eventId = createdEventIds[0];

        const catalog = await pool.query(
            "INSERT INTO ticket_categories (name) VALUES ('ZZAdminEvents Freeze') RETURNING id"
        );
        const etc = await pool.query(
            `INSERT INTO event_ticket_categories (event_id, category_id, price_paise, admits_count, ticket_quantity)
             VALUES ($1, $2, 60000, 1, 10) RETURNING id`,
            [eventId, catalog.rows[0].id]
        );
        const categoryId = etc.rows[0].id;

        // A completed purchase at the then-current 60000, inserted directly —
        // Razorpay is not under test here.
        const orderRes = await pool.query(
            `INSERT INTO orders (user_id, event_id, event_ticket_category_id, status,
                                 base_price_paise, discount_paise, subtotal_paise,
                                 gst_percentage, gst_paise, total_paise,
                                 razorpay_order_id, expires_at)
             SELECT id, $1, $2, 'paid', 60000, 0, 60000, 18, 10800, 70800,
                    'order_test_freeze_check', now() + interval '10 min'
             FROM users LIMIT 1
             RETURNING id, base_price_paise, total_paise`,
            [eventId, categoryId]
        );
        const { id: orderId, base_price_paise: frozenBase, total_paise: frozenTotal } = orderRes.rows[0];

        // Admin reprices the tier through the API.
        const patchRes = await request(app)
            .patch(`/admin/events/${eventId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ categories: [{ categoryId: catalog.rows[0].id, pricePaise: 999999, admitsCount: 1, ticketQuantity: 10 }] });
        expect(patchRes.status).toBe(200);
        expect(patchRes.body.event.categories[0].pricePaise).toBe(999999);

        // The placed order is untouched.
        const check = await pool.query('SELECT base_price_paise, total_paise FROM orders WHERE id = $1', [orderId]);
        expect(check.rows[0].base_price_paise).toBe(frozenBase);
        expect(check.rows[0].total_paise).toBe(frozenTotal);

        await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
        await pool.query('DELETE FROM event_ticket_categories WHERE id = $1', [categoryId]);
        await pool.query('DELETE FROM ticket_categories WHERE id = $1', [catalog.rows[0].id]);
    });

    it('no longer accepts or returns an event-level price or capacity', async () => {
        const res = await request(app)
            .patch(`/admin/events/${createdEventIds[0]}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ venueName: 'Post-Part-4 Venue', price: 60000, capacity: 5 });
        expect(res.status).toBe(200);

        // Ignored, not rejected — an un-updated client still works.
        expect(res.body.event).not.toHaveProperty('price');
        expect(res.body.event).not.toHaveProperty('capacity');
        expect(res.body.event.venueName).toBe('Post-Part-4 Venue');

        const stored = await pool.query('SELECT price, capacity FROM events WHERE id = $1', [createdEventIds[0]]);
        expect(stored.rows[0].price).not.toBe(60000);   // the column was not written
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

    // B6 — the banner has a clear path, matching how the gallery clears with
    // photos: [] and an artist photo with s3Key: null.
    it('clears the banner with s3Key null, and reports bannerUrl null', async () => {
        const key = await uploadTestImage(eventId, 'banner');
        await request(app)
            .patch(`/admin/events/${eventId}/banner`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ s3Key: key });

        const cleared = await request(app)
            .patch(`/admin/events/${eventId}/banner`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ s3Key: null });
        expect(cleared.status).toBe(200);
        expect(cleared.body.bannerUrl).toBeNull();

        // The column really is null, not an empty string.
        const stored = await pool.query('SELECT banner_s3_key FROM events WHERE id = $1', [eventId]);
        expect(stored.rows[0].banner_s3_key).toBeNull();

        // And the detail endpoint agrees.
        const detail = await request(app)
            .get(`/admin/events/${eventId}`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(detail.body.event.bannerUrl).toBeNull();
    });

    it('treats an empty string the same as null', async () => {
        const key = await uploadTestImage(eventId, 'banner');
        await request(app)
            .patch(`/admin/events/${eventId}/banner`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ s3Key: key });

        const cleared = await request(app)
            .patch(`/admin/events/${eventId}/banner`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ s3Key: '' });
        expect(cleared.status).toBe(200);
        expect(cleared.body.bannerUrl).toBeNull();
    });

    // Only an EXPLICIT null clears — a body that forgot the field must not
    // silently wipe the banner.
    it('still 400s when s3Key is absent entirely, leaving the banner intact', async () => {
        const key = await uploadTestImage(eventId, 'banner');
        await request(app)
            .patch(`/admin/events/${eventId}/banner`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ s3Key: key });

        const res = await request(app)
            .patch(`/admin/events/${eventId}/banner`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({});
        expect(res.status).toBe(400);

        const stored = await pool.query('SELECT banner_s3_key FROM events WHERE id = $1', [eventId]);
        expect(stored.rows[0].banner_s3_key).toBe(key);
    });

    it('can set a banner again after clearing', async () => {
        await request(app)
            .patch(`/admin/events/${eventId}/banner`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ s3Key: null });

        const key = await uploadTestImage(eventId, 'banner');
        const res = await request(app)
            .patch(`/admin/events/${eventId}/banner`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ s3Key: key });
        expect(res.status).toBe(200);
        expect(res.body.bannerUrl).toMatch(/^https:\/\//);
    });

    it('audits a clear as a from/to ending in null', async () => {
        const key = await uploadTestImage(eventId, 'banner');
        await request(app)
            .patch(`/admin/events/${eventId}/banner`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ s3Key: key });

        await request(app)
            .patch(`/admin/events/${eventId}/banner`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ s3Key: null });

        const audit = await pool.query(
            `SELECT changes FROM audit_log
             WHERE entity_type = 'event' AND entity_id = $1 AND changes ? 'banner_s3_key'
             ORDER BY created_at DESC LIMIT 1`,
            [eventId]
        );
        expect(audit.rows[0].changes.banner_s3_key.from).toBe(key);
        expect(audit.rows[0].changes.banner_s3_key.to).toBeNull();
    });

    it('admin detail exposes each gallery item s3Key, matching the stored key', async () => {
        const res = await request(app)
            .get(`/admin/events/${eventId}`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);

        const gallery = res.body.event.gallery;
        expect(gallery.length).toBe(2);
        for (const item of gallery) {
            expect(item.s3Key).toMatch(new RegExp(`^events/${eventId}/gallery/`));
            expect(item.url).toMatch(/^https:\/\//);
        }

        const db = await pool.query(
            'SELECT s3_key, position FROM event_photos WHERE event_id = $1 ORDER BY position ASC',
            [eventId]
        );
        expect(gallery.map(g => [g.s3Key, g.position]))
            .toEqual(db.rows.map(r => [r.s3_key, r.position]));
    });

    // The round-trip this s3Key exists for: adding a photo without re-uploading
    // the existing ones. PUT /gallery is a full replace, so the admin has to
    // send back the keys it just read from the detail response.
    it('gallery round-trips — detail s3Keys can be resent to preserve existing photos', async () => {
        const before = await request(app)
            .get(`/admin/events/${eventId}`)
            .set('Authorization', `Bearer ${adminToken}`);
        const existing = before.body.event.gallery;
        expect(existing.length).toBe(2);

        const newKey = await uploadTestImage(eventId, 'gallery');

        const put = await request(app)
            .put(`/admin/events/${eventId}/gallery`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ photos: [
                ...existing.map(p => ({ s3Key: p.s3Key, position: p.position })),
                { s3Key: newKey, position: 2 }
            ]});
        expect(put.status).toBe(200);
        expect(put.body.gallery.length).toBe(3);

        const after = await request(app)
            .get(`/admin/events/${eventId}`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(after.body.event.gallery.map(p => p.s3Key))
            .toEqual([existing[0].s3Key, existing[1].s3Key, newKey]);
    });

});
