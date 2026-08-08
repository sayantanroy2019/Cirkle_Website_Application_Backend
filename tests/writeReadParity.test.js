import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

const app = createApp();

const ADMIN_EMAIL = 'zzparity-admin@cirkle.live';
const ADMIN_PASSWORD = 'ParityPass123!';
const P = 'ZZParity ';

let adminId, adminToken, organizerId, eventId, catalogId;
const createdEventIds = [];
const createdOrganizerIds = [];
const createdCatalogIds = [];

const auth = () => ({ Authorization: `Bearer ${adminToken}` });
const api = () => request(app);

// The assertion this whole file exists for: a client that REPLACES its state
// with a write response must not end up with fewer fields than a read would
// have given it.
function expectNoNarrowerThan(writeBody, readBody, label) {
    const writeKeys = Object.keys(writeBody).sort();
    const readKeys = Object.keys(readBody).sort();
    const missing = readKeys.filter(k => !writeKeys.includes(k));

    expect(missing, `${label}: write response is missing ${missing.join(', ')}`).toEqual([]);
    expect(writeKeys).toEqual(readKeys);
}

beforeAll(async () => {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const a = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ($1, $2, 'Parity Admin', 'administrative') RETURNING id`,
        [ADMIN_EMAIL, hash]
    );
    adminId = a.rows[0].id;
    adminToken = (await api().post('/admin/auth/login')
        .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).body.token;

    const cat = await pool.query(
        'INSERT INTO ticket_categories (name) VALUES ($1) RETURNING id', [P + 'Pass']
    );
    catalogId = cat.rows[0].id;
    createdCatalogIds.push(catalogId);
});

afterAll(async () => {
    await pool.query('DELETE FROM event_ticket_categories WHERE event_id = ANY($1)', [createdEventIds]);
    await pool.query('DELETE FROM audit_log WHERE admin_id = $1', [adminId]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [createdEventIds]);
    await pool.query('DELETE FROM organizers WHERE id = ANY($1)', [createdOrganizerIds]);
    await pool.query('DELETE FROM ticket_categories WHERE id = ANY($1)', [createdCatalogIds]);
    await pool.query('DELETE FROM admins WHERE id = $1', [adminId]);
    await pool.end();
});

describe('B5 — admin events: create and edit match the detail projection', () => {

    it('POST returns the same key set as GET', async () => {
        const created = await api().post('/admin/events').set(auth()).send({
            name: P + 'Created Event',
            categoryId: 'club',
            cityId: 'del',
            startsAt: new Date(Date.now() + 30 * 86400000).toISOString(),
            targetGroupSize: 3
        });
        expect(created.status).toBe(201);
        eventId = created.body.event.id;
        createdEventIds.push(eventId);

        const read = await api().get(`/admin/events/${eventId}`).set(auth());
        expect(read.status).toBe(200);

        expectNoNarrowerThan(created.body.event, read.body.event, 'POST /admin/events');
    });

    it('PATCH returns the same key set as GET', async () => {
        const patched = await api().patch(`/admin/events/${eventId}`).set(auth())
            .send({ venueName: 'Parity Venue' });
        expect(patched.status).toBe(200);

        const read = await api().get(`/admin/events/${eventId}`).set(auth());
        expectNoNarrowerThan(patched.body.event, read.body.event, 'PATCH /admin/events/:id');
    });

    // The specific fields the bug report named.
    it('PATCH carries gallery, organizer and the category fields', async () => {
        const patched = await api().patch(`/admin/events/${eventId}`).set(auth())
            .send({ description: 'Now with everything' });

        for (const field of ['gallery', 'organizer', 'categories', 'capacitySummary', 'priceRange']) {
            expect(patched.body.event, `PATCH response missing ${field}`).toHaveProperty(field);
        }
        expect(Array.isArray(patched.body.event.gallery)).toBe(true);
    });

    // The bug in its original form: edit something unrelated, and the fields
    // you weren't touching must survive in the response.
    it('does not drop populated categories when editing an unrelated field', async () => {
        await api().patch(`/admin/events/${eventId}`).set(auth()).send({
            categories: [{ categoryId: catalogId, pricePaise: 50000, admitsCount: 1, ticketQuantity: 10 }]
        });

        const patched = await api().patch(`/admin/events/${eventId}`).set(auth())
            .send({ venueName: 'Unrelated Edit' });

        expect(patched.body.event.categories.length).toBe(1);
        expect(patched.body.event.capacitySummary.totalPeople).toBe(10);
        expect(patched.body.event.priceRange).toEqual({ minPaise: 50000, maxPaise: 50000 });

        const read = await api().get(`/admin/events/${eventId}`).set(auth());
        expect(patched.body.event.categories).toEqual(read.body.event.categories);
    });

    it('agrees with GET on values, not just keys', async () => {
        const patched = await api().patch(`/admin/events/${eventId}`).set(auth())
            .send({ description: 'Value parity check' });
        const read = await api().get(`/admin/events/${eventId}`).set(auth());

        // updatedAt legitimately differs (the PATCH wrote it); everything else
        // should be identical, and bannerUrl is a freshly-signed URL each read.
        const ignore = new Set(['updatedAt', 'bannerUrl', 'gallery', 'categories']);
        for (const key of Object.keys(read.body.event)) {
            if (ignore.has(key)) continue;
            expect(patched.body.event[key], `mismatch on ${key}`).toEqual(read.body.event[key]);
        }
    });

});

describe('B5 — admin organizers: create and edit match the detail projection', () => {

    it('POST returns the same key set as GET, including eventCount', async () => {
        const created = await api().post('/admin/organizers').set(auth()).send({
            email: 'zzparity-org@cirkle.live',
            password: 'OrganizerPass123!',
            displayName: P + 'Organizer'
        });
        expect(created.status).toBe(201);
        organizerId = created.body.organizer.id;
        createdOrganizerIds.push(organizerId);

        const read = await api().get(`/admin/organizers/${organizerId}`).set(auth());
        expect(read.status).toBe(200);

        expectNoNarrowerThan(created.body.organizer, read.body.organizer, 'POST /admin/organizers');
        expect(created.body.organizer).toHaveProperty('eventCount');
        expect(created.body.organizer.eventCount).toBe(0);
    });

    it('PATCH returns the same key set as GET, including eventCount', async () => {
        const patched = await api().patch(`/admin/organizers/${organizerId}`).set(auth())
            .send({ displayName: P + 'Renamed' });
        expect(patched.status).toBe(200);

        const read = await api().get(`/admin/organizers/${organizerId}`).set(auth());
        expectNoNarrowerThan(patched.body.organizer, read.body.organizer, 'PATCH /admin/organizers/:id');
        expect(patched.body.organizer).toHaveProperty('eventCount');
    });

    it('reports a real eventCount on write, not a stale zero', async () => {
        // Give the organizer an event, then edit the organizer.
        const ev = await api().post('/admin/events').set(auth()).send({
            name: P + 'Organizer Event',
            categoryId: 'club',
            cityId: 'del',
            startsAt: new Date(Date.now() + 25 * 86400000).toISOString(),
            targetGroupSize: 2,
            organizerId
        });
        createdEventIds.push(ev.body.event.id);

        const patched = await api().patch(`/admin/organizers/${organizerId}`).set(auth())
            .send({ displayName: P + 'With An Event' });

        expect(patched.body.organizer.eventCount).toBe(1);

        const read = await api().get(`/admin/organizers/${organizerId}`).set(auth());
        expect(patched.body.organizer.eventCount).toBe(read.body.organizer.eventCount);
    });

});

describe('B5 — the endpoints that were already consistent stay consistent', () => {

    it('admin ticket categories: POST and PATCH match GET', async () => {
        const created = await api().post('/admin/ticket-categories').set(auth())
            .send({ name: P + 'Parity Category' });
        expect(created.status).toBe(201);
        createdCatalogIds.push(created.body.ticketCategory.id);

        const listed = (await api().get('/admin/ticket-categories').set(auth()))
            .body.ticketCategories.find(c => c.id === created.body.ticketCategory.id);

        expectNoNarrowerThan(created.body.ticketCategory, listed, 'POST /admin/ticket-categories');

        const patched = await api().patch(`/admin/ticket-categories/${created.body.ticketCategory.id}`)
            .set(auth()).send({ name: P + 'Parity Renamed' });
        expectNoNarrowerThan(patched.body.ticketCategory, listed, 'PATCH /admin/ticket-categories/:id');
    });

    it('admin admins: PATCH matches GET', async () => {
        const target = await pool.query(
            `INSERT INTO admins (email, password_hash, display_name, role)
             VALUES ($1, $2, 'Parity Target', 'business_development') RETURNING id`,
            ['zzparity-target@cirkle.live', await bcrypt.hash('IrrelevantPass123!', 10)]
        );
        const targetId = target.rows[0].id;

        const patched = await api().patch(`/admin/admins/${targetId}`).set(auth())
            .send({ displayName: 'Parity Target Renamed' });
        expect(patched.status).toBe(200);

        const read = await api().get(`/admin/admins/${targetId}`).set(auth());
        expectNoNarrowerThan(patched.body.admin, read.body.admin, 'PATCH /admin/admins/:id');

        await pool.query('DELETE FROM audit_log WHERE entity_id = $1', [targetId]);
        await pool.query('DELETE FROM admins WHERE id = $1', [targetId]);
    });

});
