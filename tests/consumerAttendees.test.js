import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

const app = createApp();

// Three attendees plus one viewer who holds no ticket, so the "any logged-in
// user may read this" rule is tested by someone who genuinely isn't going.
const PHONES = {
    alice:    '+916767676761',
    bob:      '+916767676762',
    priya:    '+916767676763',
    outsider: '+916767676764'
};
// Distinctive values that must never reach this response.
const SECRET_EMAIL   = 'roster-must-not-leak@cirkle.live';
const SECRET_LASTNAME = 'Unleakable';
const SECRET_BIO      = 'this bio must not appear in the roster';
const SECRET_HANDLE   = 'secrethandle';

const users = {};
let eventId, emptyEventId;
const tokens = {};
const createdOrderIds = [];

async function issueTicket(userId, forEventId, ref) {
    const order = await pool.query(
        `INSERT INTO orders (user_id, event_id, status, base_price_paise, discount_paise,
                             subtotal_paise, gst_percentage, gst_paise, total_paise,
                             razorpay_order_id, expires_at)
         VALUES ($1, $2, 'paid', 50000, 0, 50000, 18, 9000, 59000, $3, now() + interval '10 min')
         RETURNING id`,
        [userId, forEventId, ref]
    );
    createdOrderIds.push(order.rows[0].id);
    const ticket = await pool.query(
        'INSERT INTO tickets (order_id, user_id, event_id) VALUES ($1, $2, $3) RETURNING id',
        [order.rows[0].id, userId, forEventId]
    );
    return ticket.rows[0].id;
}

const getRoster = (token, query = '') =>
    request(app).get(`/events/${eventId}/attendees${query}`).set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
    for (const [name, phone] of Object.entries(PHONES)) {
        const login = await request(app).post('/auth/login').send({ phone });
        tokens[name] = login.body.token;
        const u = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
        users[name] = u.rows[0].id;
    }

    // POST /auth/login already created a stub profiles row, so every seed here
    // has to UPDATE on conflict rather than rely on the INSERT landing.
    const seedProfile = (userId, cols) => {
        const names = Object.keys(cols);
        const placeholders = names.map((_, i) => `$${i + 2}`);
        return pool.query(
            `INSERT INTO profiles (user_id, ${names.join(', ')})
             VALUES ($1, ${placeholders.join(', ')})
             ON CONFLICT (user_id) DO UPDATE SET
             ${names.map(n => `${n} = EXCLUDED.${n}`).join(', ')}`,
            [userId, ...names.map(n => cols[n])]
        );
    };

    // Alice carries every field that must NOT surface in this response.
    await seedProfile(users.alice, {
        first_name: 'Alice', last_name: SECRET_LASTNAME, gender: 'woman',
        city_id: 'del', date_of_birth: '1998-03-15', email: SECRET_EMAIL,
        bio: SECRET_BIO, tagline: 'Always up for an adventure',
        facebook: SECRET_HANDLE, instagram: SECRET_HANDLE, linkedin: SECRET_HANDLE
    });
    // Bob has no tagline and no photos — the sparse-profile case.
    await seedProfile(users.bob, {
        first_name: 'Bob', gender: 'man', city_id: 'del', date_of_birth: '1995-07-20'
    });
    await seedProfile(users.priya, {
        first_name: 'Priya', gender: 'woman', city_id: 'del',
        date_of_birth: '1999-01-05', tagline: 'Live music forever'
    });
    await seedProfile(users.outsider, {
        first_name: 'Outsider', gender: 'non_binary', city_id: 'del', date_of_birth: '1994-11-11'
    });

    // Alice gets a genuinely uploaded photo, so the presigned URL in the
    // response points at an object that really exists and can be fetched.
    const urlRes = await request(app)
        .post('/uploads/profile-photo-url')
        .set('Authorization', `Bearer ${tokens.alice}`)
        .send({ contentType: 'image/jpeg' });
    await fetch(urlRes.body.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: Buffer.from('roster-test-photo-bytes')
    });
    await pool.query(
        'INSERT INTO profile_photos (user_id, s3_key, position) VALUES ($1, $2, 0)',
        [users.alice, urlRes.body.key]
    );

    const ev = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size)
         VALUES ('Roster Test Event', 'concert', 'del', now() + interval '15 days', 50000, 3)
         RETURNING id`
    );
    eventId = ev.rows[0].id;

    const empty = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size)
         VALUES ('Roster Empty Event', 'club', 'del', now() + interval '15 days', 30000, 2)
         RETURNING id`
    );
    emptyEventId = empty.rows[0].id;

    // Deliberately staggered so created_at ordering is deterministic.
    await issueTicket(users.alice, eventId, 'order_roster_alice');
    await issueTicket(users.bob, eventId, 'order_roster_bob');
    await issueTicket(users.priya, eventId, 'order_roster_priya');
});

afterAll(async () => {
    await pool.query('DELETE FROM tickets WHERE event_id = ANY($1)', [[eventId, emptyEventId]]);
    await pool.query('DELETE FROM orders WHERE id = ANY($1)', [createdOrderIds]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [[eventId, emptyEventId]]);
    await pool.query('DELETE FROM profile_photos WHERE user_id = ANY($1)', [Object.values(users)]);
    await pool.query('DELETE FROM profiles WHERE user_id = ANY($1)', [Object.values(users)]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [Object.values(users)]);
    await pool.end();
});

describe('GET /events/:id/attendees — access', () => {

    it('requires authentication', async () => {
        const res = await request(app).get(`/events/${eventId}/attendees`);
        expect(res.status).toBe(401);
    });

    it('is readable by a logged-in user who holds NO ticket to the event', async () => {
        const res = await getRoster(tokens.outsider);
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(3);
        expect(res.body.data.length).toBe(3);
    });

    it('404s for an unknown event', async () => {
        const res = await request(app)
            .get('/events/00000000-0000-0000-0000-000000000000/attendees')
            .set('Authorization', `Bearer ${tokens.outsider}`);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Event not found');
    });

    it('returns 200 with an empty roster, not 404, when nobody is attending', async () => {
        const res = await request(app)
            .get(`/events/${emptyEventId}/attendees`)
            .set('Authorization', `Bearer ${tokens.outsider}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
        expect(res.body.total).toBe(0);
    });

});

describe('GET /events/:id/attendees — envelope and shape', () => {

    it('uses the standard { data, total, limit, offset } envelope with the shared defaults', async () => {
        const res = await getRoster(tokens.outsider);
        expect(Object.keys(res.body).sort()).toEqual(['data', 'limit', 'offset', 'total']);
        expect(res.body.limit).toBe(50);
        expect(res.body.offset).toBe(0);
        expect(typeof res.body.total).toBe('number');
    });

    it('clamps limit at 100', async () => {
        const res = await getRoster(tokens.outsider, '?limit=500');
        expect(res.body.limit).toBe(100);
    });

    it('returns exactly the PersonCard fields plus isYou — no extras', async () => {
        const res = await getRoster(tokens.outsider);
        const alice = res.body.data.find(p => p.firstName === 'Alice');

        expect(Object.keys(alice).sort()).toEqual(
            ['age', 'firstName', 'gender', 'id', 'isYou', 'lifestyleTags', 'photos', 'tagline'].sort()
        );
        expect(alice.age).toBe(28);   // born 1998-03-15
        expect(alice.gender).toBe('woman');
        expect(alice.tagline).toBe('Always up for an adventure');
    });

    it('gives a sparse profile empty arrays and a null tagline rather than omitting them', async () => {
        const res = await getRoster(tokens.outsider);
        const bob = res.body.data.find(p => p.firstName === 'Bob');
        expect(bob.tagline).toBeNull();
        expect(bob.photos).toEqual([]);
        expect(bob.lifestyleTags).toEqual([]);
    });

});

describe('GET /events/:id/attendees — the privacy guarantee', () => {

    it('leaks no contact info, no last name, no bio and no social handles', async () => {
        const res = await getRoster(tokens.outsider);
        const raw = JSON.stringify(res.body);

        // The actual values, seeded to be distinctive and greppable.
        expect(raw).not.toContain(SECRET_EMAIL);
        expect(raw).not.toContain(SECRET_LASTNAME);
        expect(raw).not.toContain(SECRET_BIO);
        expect(raw).not.toContain(SECRET_HANDLE);
        expect(raw).not.toContain(PHONES.alice);

        // And the field names that would carry them.
        expect(raw).not.toMatch(/"phone"|"email"|"lastName"|"bio"|"facebook"|"instagram"|"linkedin"/);
    });

    it('returns age but never the date of birth', async () => {
        const res = await getRoster(tokens.outsider);
        const raw = JSON.stringify(res.body);

        expect(res.body.data.every(p => typeof p.age === 'number')).toBe(true);
        expect(raw).not.toMatch(/dateOfBirth|date_of_birth/);
        expect(raw).not.toContain('1998-03-15');
    });

    // The organizer roster deliberately carries handles; this one must not.
    // Proving they diverge is the point of having two helpers.
    it('is strictly narrower than the organizer-facing card', async () => {
        const res = await getRoster(tokens.outsider);
        const consumerFields = Object.keys(res.body.data[0]);

        for (const organizerOnly of ['lastName', 'bio', 'facebook', 'instagram', 'linkedin']) {
            expect(consumerFields).not.toContain(organizerOnly);
        }
    });

});

describe('GET /events/:id/attendees — dedup, paging and isYou', () => {

    it('returns one row per person, and never the same person twice', async () => {
        const res = await getRoster(tokens.outsider);
        const ids = res.body.data.map(p => p.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(res.body.total).toBe(new Set(ids).size);
    });

    // A genuine duplicate can't be constructed: tickets carries
    // UNIQUE (user_id, event_id), so the DB refuses a second ticket before
    // application logic or DISTINCT ON ever matter. Asserting the constraint
    // is the honest version of this check — it's what actually guarantees
    // one row per person; the DISTINCT ON in the query is defence in depth
    // for the day that constraint is relaxed.
    it('is backed by a DB constraint making a duplicate ticket impossible', async () => {
        const constraint = await pool.query(
            `SELECT pg_get_constraintdef(oid) AS def
             FROM pg_constraint
             WHERE conrelid = 'tickets'::regclass AND contype = 'u'`
        );
        expect(constraint.rows.map(r => r.def)).toContain('UNIQUE (user_id, event_id)');

        await expect(
            issueTicket(users.alice, eventId, 'order_roster_alice_dupe')
        ).rejects.toThrow();
    });

    it('pages with limit=1 visiting every attendee exactly once — no dupes, no drops', async () => {
        const seen = [];
        for (let offset = 0; offset < 3; offset++) {
            const page = await getRoster(tokens.outsider, `?limit=1&offset=${offset}`);
            expect(page.body.data.length).toBe(1);
            expect(page.body.total).toBe(3);   // total is independent of paging
            seen.push(page.body.data[0].id);
        }

        expect(new Set(seen).size).toBe(3);
        expect(new Set(seen)).toEqual(new Set([users.alice, users.bob, users.priya]));
    });

    it('returns an empty page with the true total when offset is past the end', async () => {
        const res = await getRoster(tokens.outsider, '?offset=99');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
        expect(res.body.total).toBe(3);
    });

    it('flags the viewer own row with isYou, and only that row', async () => {
        const res = await getRoster(tokens.alice);
        expect(res.status).toBe(200);

        const mine = res.body.data.filter(p => p.isYou);
        expect(mine.length).toBe(1);
        expect(mine[0].id).toBe(users.alice);
        // Included, not filtered — the count must match the roster length.
        expect(res.body.total).toBe(3);
        expect(res.body.data.length).toBe(3);
    });

    it('flags nobody when the viewer is not attending', async () => {
        const res = await getRoster(tokens.outsider);
        expect(res.body.data.every(p => p.isYou === false)).toBe(true);
    });

});

describe('GET /events/:id/attendees — photos and past events', () => {

    it('returns presigned photo URLs that actually fetch', async () => {
        const res = await getRoster(tokens.outsider);
        const withPhoto = res.body.data.find(p => p.photos.length > 0);
        expect(withPhoto).toBeDefined();

        const url = withPhoto.photos[0].url;
        expect(url).toMatch(/^https:\/\//);
        expect(url).toMatch(/X-Amz-Signature=/);

        const fetched = await fetch(url);
        expect(fetched.status).toBe(200);
    });

    it('still returns the roster for an event that has already started', async () => {
        await pool.query(
            "UPDATE events SET starts_at = now() - interval '2 days' WHERE id = $1",
            [eventId]
        );

        const res = await getRoster(tokens.outsider);
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(3);

        await pool.query(
            "UPDATE events SET starts_at = now() + interval '15 days' WHERE id = $1",
            [eventId]
        );
    });

});
