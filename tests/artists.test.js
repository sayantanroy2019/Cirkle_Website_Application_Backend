import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { normalizeInstagram } from '../src/utils/socialHandles.js';

const app = createApp();

const ADMIN_EMAIL = 'test-admin-artists@cirkle.live';
const ADMIN_PASSWORD = 'AdminArtistsPass123!';
const ORG_EMAIL = 'test-org-artists@cirkle.live';
const USER_PHONE = '+916868686870';

let adminId, orgId, eventId, adminToken, userToken;

async function uploadArtistPhoto(artistId, contentType = 'image/jpeg') {
    const urlRes = await request(app)
        .post(`/admin/events/${eventId}/artists/${artistId}/image-url`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ contentType });

    await fetch(urlRes.body.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: Buffer.from('test-artist-photo-bytes')
    });

    return urlRes.body.key;
}

const setLineup = artists =>
    request(app)
        .put(`/admin/events/${eventId}/artists`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ artists });

beforeAll(async () => {
    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const adminRow = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ($1, $2, 'Test Artists Admin', 'administrative') RETURNING id`,
        [ADMIN_EMAIL, adminHash]
    );
    adminId = adminRow.rows[0].id;

    const orgHash = await bcrypt.hash('irrelevant-not-tested-here', 10);
    const orgRow = await pool.query(
        `INSERT INTO organizers (email, password_hash, display_name, instagram)
         VALUES ($1, $2, 'Test Artists Organizer', 'kittysu') RETURNING id`,
        [ORG_EMAIL, orgHash]
    );
    orgId = orgRow.rows[0].id;

    const eventRow = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size, organizer_id)
         VALUES ('Artists Test Event', 'concert', 'del', now() + interval '30 days', 50000, 3, $1)
         RETURNING id`,
        [orgId]
    );
    eventId = eventRow.rows[0].id;

    const adminLogin = await request(app).post('/admin/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminToken = adminLogin.body.token;

    const userLogin = await request(app).post('/auth/login').send({ phone: USER_PHONE });
    userToken = userLogin.body.token;
}, 30000);

afterAll(async () => {
    await pool.query('DELETE FROM audit_log WHERE entity_type = $1 AND entity_id = $2', ['event', eventId]);
    await pool.query('DELETE FROM event_artists WHERE event_id = $1', [eventId]);
    await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
    await pool.query('DELETE FROM organizers WHERE id = $1', [orgId]);
    await pool.query('DELETE FROM admins WHERE id = $1', [adminId]);
    await pool.query('DELETE FROM users WHERE phone = $1', [USER_PHONE]);
    await pool.end();
}, 30000);

describe('normalizeInstagram', () => {

    it('reduces every accepted form to the bare handle', () => {
        expect(normalizeInstagram('https://www.instagram.com/arijitsingh/?igsh=xyz')).toBe('arijitsingh');
        expect(normalizeInstagram('instagram.com/arijitsingh')).toBe('arijitsingh');
        expect(normalizeInstagram('@arijitsingh')).toBe('arijitsingh');
        expect(normalizeInstagram('  arijitsingh  ')).toBe('arijitsingh');
        expect(normalizeInstagram('Test_1.x')).toBe('Test_1.x');
    });

    it('treats empty, blank, null and undefined all as null', () => {
        expect(normalizeInstagram('')).toBeNull();
        expect(normalizeInstagram('   ')).toBeNull();
        expect(normalizeInstagram(null)).toBeNull();
        expect(normalizeInstagram(undefined)).toBeNull();
    });

    it('rejects things that are not plausible handles', () => {
        expect(() => normalizeInstagram('not a handle')).toThrow('INVALID_HANDLE');
        expect(() => normalizeInstagram('user@example.com')).toThrow('INVALID_HANDLE');
        expect(() => normalizeInstagram('https://twitter.com/someone')).toThrow('INVALID_HANDLE');
        expect(() => normalizeInstagram('a'.repeat(31))).toThrow('INVALID_HANDLE');
    });

});

describe('PUT /admin/events/:id/artists — validation', () => {

    it('rejects more than 10 artists', async () => {
        const res = await setLineup(
            Array.from({ length: 11 }, (_, i) => ({ name: `Artist ${i}`, position: i }))
        );
        expect(res.status).toBe(400);
    });

    it('rejects a missing name', async () => {
        const res = await setLineup([{ name: '   ', position: 0 }]);
        expect(res.status).toBe(400);
    });

    it('rejects duplicate positions', async () => {
        const res = await setLineup([
            { name: 'A', position: 0 },
            { name: 'B', position: 0 }
        ]);
        expect(res.status).toBe(400);
    });

    it('rejects an out-of-range position', async () => {
        const res = await setLineup([{ name: 'A', position: 10 }]);
        expect(res.status).toBe(400);
    });

    it('rejects an unparseable Instagram handle', async () => {
        const res = await setLineup([{ name: 'A', instagram: 'not a handle', position: 0 }]);
        expect(res.status).toBe(400);
    });

    it('rejects an artist id belonging to another event', async () => {
        const res = await setLineup([
            { id: '00000000-0000-0000-0000-000000000000', name: 'Ghost', position: 0 }
        ]);
        expect(res.status).toBe(400);
    });

    it('404s on an unknown event', async () => {
        const res = await request(app)
            .put('/admin/events/00000000-0000-0000-0000-000000000000/artists')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ artists: [] });
        expect(res.status).toBe(404);
    });

});

describe('PUT /admin/events/:id/artists — the lineup lifecycle', () => {

    it('saves a lineup, normalizes handles on write, and writes an audit row', async () => {
        const res = await setLineup([
            { name: 'Arijit Singh', instagram: 'https://instagram.com/arijitsingh/', position: 0 },
            { name: 'Dua Lipa', instagram: '@dualipa', position: 1 },
            { name: 'No Socials', position: 2 }
        ]);
        expect(res.status).toBe(200);
        expect(res.body.artists.length).toBe(3);

        // Ordered by position, headliner first
        expect(res.body.artists.map(a => a.name)).toEqual(['Arijit Singh', 'Dua Lipa', 'No Socials']);
        // Stored bare — no @, no URL
        expect(res.body.artists[0].instagram).toBe('arijitsingh');
        expect(res.body.artists[1].instagram).toBe('dualipa');
        expect(res.body.artists[2].instagram).toBeNull();
        // No photos yet
        expect(res.body.artists.every(a => a.photoUrl === null)).toBe(true);

        const stored = await pool.query('SELECT instagram FROM event_artists WHERE event_id = $1 ORDER BY position', [eventId]);
        expect(stored.rows.map(r => r.instagram)).toEqual(['arijitsingh', 'dualipa', null]);

        const audit = await pool.query(
            `SELECT changes FROM audit_log
             WHERE entity_type = 'event' AND entity_id = $1 AND changes ? 'artists'
             ORDER BY created_at DESC LIMIT 1`,
            [eventId]
        );
        expect(audit.rows.length).toBe(1);
        expect(audit.rows[0].changes.artists.to.length).toBe(3);
    });

    it('GET returns the same lineup in position order', async () => {
        const res = await request(app)
            .get(`/admin/events/${eventId}/artists`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.artists.map(a => a.position)).toEqual([0, 1, 2]);
    });

    // The reason PUT is an upsert rather than a delete-and-reinsert.
    it('updating by id preserves the artist row id and its photo', async () => {
        const before = await request(app)
            .get(`/admin/events/${eventId}/artists`)
            .set('Authorization', `Bearer ${adminToken}`);
        const headliner = before.body.artists[0];

        const key = await uploadArtistPhoto(headliner.id);
        const attach = await request(app)
            .patch(`/admin/events/${eventId}/artists/${headliner.id}/photo`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ s3Key: key });
        expect(attach.status).toBe(200);
        expect(attach.body.photoUrl).toMatch(/^https:\/\//);

        // Rename the headliner via PUT, sending its id back
        const res = await setLineup([
            { id: headliner.id, name: 'Arijit Singh (Live)', instagram: 'arijitsingh', position: 0 },
            ...before.body.artists.slice(1).map(a => ({ id: a.id, name: a.name, instagram: a.instagram, position: a.position }))
        ]);
        expect(res.status).toBe(200);

        const updated = res.body.artists.find(a => a.id === headliner.id);
        expect(updated.name).toBe('Arijit Singh (Live)');
        expect(updated.photoUrl).toMatch(/^https:\/\//);   // photo survived the edit

        const stored = await pool.query('SELECT photo_s3_key FROM event_artists WHERE id = $1', [headliner.id]);
        expect(stored.rows[0].photo_s3_key).toBe(key);
    });

    it('reorders an existing lineup without tripping the unique position constraint', async () => {
        const before = await request(app)
            .get(`/admin/events/${eventId}/artists`)
            .set('Authorization', `Bearer ${adminToken}`);
        const [first, second, third] = before.body.artists;

        // Straight swap of 0 and 1 — collides mid-transaction unless the
        // UNIQUE (event_id, position) constraint is deferred to COMMIT.
        const res = await setLineup([
            { id: second.id, name: second.name, instagram: second.instagram, position: 0 },
            { id: first.id,  name: first.name,  instagram: first.instagram,  position: 1 },
            { id: third.id,  name: third.name,  instagram: third.instagram,  position: 2 }
        ]);
        expect(res.status).toBe(200);
        expect(res.body.artists.map(a => a.id)).toEqual([second.id, first.id, third.id]);
    });

    it('omitting an artist deletes its row, leaving nothing dangling', async () => {
        const before = await request(app)
            .get(`/admin/events/${eventId}/artists`)
            .set('Authorization', `Bearer ${adminToken}`);
        const dropped = before.body.artists[2];

        const res = await setLineup(
            before.body.artists.slice(0, 2).map(a => ({ id: a.id, name: a.name, instagram: a.instagram, position: a.position }))
        );
        expect(res.status).toBe(200);
        expect(res.body.artists.length).toBe(2);

        const gone = await pool.query('SELECT id FROM event_artists WHERE id = $1', [dropped.id]);
        expect(gone.rows.length).toBe(0);

        const total = await pool.query('SELECT COUNT(*) FROM event_artists WHERE event_id = $1', [eventId]);
        expect(parseInt(total.rows[0].count, 10)).toBe(2);
    });

});

describe('Artist photos', () => {

    it('rejects an s3Key namespaced to a different artist', async () => {
        const list = await request(app)
            .get(`/admin/events/${eventId}/artists`)
            .set('Authorization', `Bearer ${adminToken}`);
        const [a, b] = list.body.artists;

        const keyForA = await uploadArtistPhoto(a.id);

        const res = await request(app)
            .patch(`/admin/events/${eventId}/artists/${b.id}/photo`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ s3Key: keyForA });
        expect(res.status).toBe(400);
    });

    it('rejects a key that was never uploaded', async () => {
        const list = await request(app)
            .get(`/admin/events/${eventId}/artists`)
            .set('Authorization', `Bearer ${adminToken}`);
        const artist = list.body.artists[0];

        const res = await request(app)
            .patch(`/admin/events/${eventId}/artists/${artist.id}/photo`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ s3Key: `events/${eventId}/artists/${artist.id}/never-uploaded.jpg` });
        expect(res.status).toBe(400);
    });

    it('rejects an unsupported content type', async () => {
        const list = await request(app)
            .get(`/admin/events/${eventId}/artists`)
            .set('Authorization', `Bearer ${adminToken}`);

        const res = await request(app)
            .post(`/admin/events/${eventId}/artists/${list.body.artists[0].id}/image-url`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ contentType: 'application/pdf' });
        expect(res.status).toBe(400);
    });

    it('404s for an artist that is not on this event', async () => {
        const res = await request(app)
            .post(`/admin/events/${eventId}/artists/00000000-0000-0000-0000-000000000000/image-url`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ contentType: 'image/jpeg' });
        expect(res.status).toBe(404);
    });

    it('clears a photo with s3Key null', async () => {
        const list = await request(app)
            .get(`/admin/events/${eventId}/artists`)
            .set('Authorization', `Bearer ${adminToken}`);
        const artist = list.body.artists.find(a => a.photoUrl !== null);
        expect(artist).toBeDefined();

        const res = await request(app)
            .patch(`/admin/events/${eventId}/artists/${artist.id}/photo`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ s3Key: null });
        expect(res.status).toBe(200);
        expect(res.body.photoUrl).toBeNull();

        const stored = await pool.query('SELECT photo_s3_key FROM event_artists WHERE id = $1', [artist.id]);
        expect(stored.rows[0].photo_s3_key).toBeNull();
    });

});

describe('Consumer GET /events/:id — lineup and organizer handle', () => {

    it('returns artists and organizerInstagram, with presigned photoUrl and no raw keys', async () => {
        // Give the headliner a photo so the presigned path is exercised
        const list = await request(app)
            .get(`/admin/events/${eventId}/artists`)
            .set('Authorization', `Bearer ${adminToken}`);
        const headliner = list.body.artists[0];
        const key = await uploadArtistPhoto(headliner.id);
        await request(app)
            .patch(`/admin/events/${eventId}/artists/${headliner.id}/photo`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ s3Key: key });

        const res = await request(app)
            .get(`/events/${eventId}`)
            .set('Authorization', `Bearer ${userToken}`);
        expect(res.status).toBe(200);

        expect(Array.isArray(res.body.event.artists)).toBe(true);
        expect(res.body.event.artists.length).toBe(2);
        expect(res.body.event.artists.map(a => a.position)).toEqual([0, 1]);
        expect(res.body.event.artists[0].photoUrl).toMatch(/^https:\/\//);
        expect(res.body.event.artists[1].photoUrl).toBeNull();
        expect(res.body.event.organizerInstagram).toBe('kittysu');

        // The whole point: consumers get presigned URLs, never a bare storage
        // key, and never anything else about the organizer.
        //
        // Note the key itself DOES appear in the response — a presigned URL is
        // literally https://{bucket}/{key}?X-Amz-Signature=..., so the path
        // component is unavoidable. What must not appear is the key as its own
        // field, unsigned and reusable. Assert on the field names (same check
        // the gallery test uses), and confirm the only place the key shows up
        // is inside a signed URL.
        const raw = JSON.stringify(res.body);
        expect(raw).not.toMatch(/s3Key|photo_s3_key|"s3_key"/);
        expect(raw).not.toContain(ORG_EMAIL);
        expect(raw).not.toContain('Test Artists Organizer');

        const withPhoto = res.body.event.artists.find(a => a.photoUrl !== null);
        expect(withPhoto.photoUrl).toContain(key);
        expect(withPhoto.photoUrl).toMatch(/X-Amz-Signature=/);
        // Every occurrence of the key is within that signed URL, nowhere else.
        expect(raw.split(key).length - 1).toBe(1);
    });

    it('returns an empty lineup rather than omitting the field', async () => {
        const bare = await pool.query(
            `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size)
             VALUES ('No Lineup Event', 'club', 'del', now() + interval '20 days', 30000, 2)
             RETURNING id`
        );
        const bareId = bare.rows[0].id;

        const res = await request(app)
            .get(`/events/${bareId}`)
            .set('Authorization', `Bearer ${userToken}`);
        expect(res.status).toBe(200);
        expect(res.body.event.artists).toEqual([]);
        // No organizer on this event at all
        expect(res.body.event.organizerInstagram).toBeNull();

        await pool.query('DELETE FROM events WHERE id = $1', [bareId]);
    });

});

describe('Organizer Instagram — admin create and edit', () => {

    const EDIT_EMAIL = 'test-org-ig-edit@cirkle.live';
    let createdId;

    afterAll(async () => {
        if (createdId) {
            await pool.query('DELETE FROM audit_log WHERE entity_type = $1 AND entity_id = $2', ['organizer', createdId]);
            await pool.query('DELETE FROM organizers WHERE id = $1', [createdId]);
        }
    });

    it('normalizes the handle on create', async () => {
        const res = await request(app)
            .post('/admin/organizers')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                email: EDIT_EMAIL,
                password: 'OrganizerPass123!',
                displayName: 'IG Test Venue',
                instagram: 'https://www.instagram.com/igtestvenue/'
            });
        expect(res.status).toBe(201);
        expect(res.body.organizer.instagram).toBe('igtestvenue');
        createdId = res.body.organizer.id;
    });

    it('rejects an unparseable handle on create', async () => {
        const res = await request(app)
            .post('/admin/organizers')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                email: 'test-org-ig-bad@cirkle.live',
                password: 'OrganizerPass123!',
                displayName: 'Bad IG',
                instagram: 'this is not a handle'
            });
        expect(res.status).toBe(400);
    });

    it('updates and then clears the handle', async () => {
        const updated = await request(app)
            .patch(`/admin/organizers/${createdId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ instagram: '@newhandle' });
        expect(updated.status).toBe(200);
        expect(updated.body.organizer.instagram).toBe('newhandle');

        const cleared = await request(app)
            .patch(`/admin/organizers/${createdId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ instagram: '' });
        expect(cleared.status).toBe(200);
        expect(cleared.body.organizer.instagram).toBeNull();
    });

    it('omitting instagram leaves it untouched', async () => {
        await request(app)
            .patch(`/admin/organizers/${createdId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ instagram: 'stillhere' });

        const res = await request(app)
            .patch(`/admin/organizers/${createdId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ displayName: 'Renamed Venue' });
        expect(res.status).toBe(200);
        expect(res.body.organizer.instagram).toBe('stillhere');
    });

});
