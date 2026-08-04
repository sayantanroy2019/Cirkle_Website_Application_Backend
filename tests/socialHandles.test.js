import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { normalizeFacebook, normalizeInstagram, normalizeLinkedin } from '../src/utils/socialHandles.js';
import { checkRequiredHandles } from '../src/utils/socialGate.js';

const app = createApp();

const USER_PHONE = '+916969696971';
// A second ticket-holder, used only to fill an event to capacity. It has to be
// someone other than the test user: orders.js rejects a user who already holds
// a ticket before it ever loads the event, which would mask the gate.
const FILLER_PHONE = '+916969696972';
const ORG_EMAIL = 'test-org-social@cirkle.live';
const ORG_PASSWORD = 'OrgSocialPass123!';
const ADMIN_EMAIL = 'test-admin-social@cirkle.live';
const ADMIN_PASSWORD = 'AdminSocialPass123!';

let userId, userToken, fillerUserId, orgId, orgToken, adminId, adminToken;
let openEventId, inviteEventId;

const patchProfile = body =>
    request(app).patch('/profile/me').set('Authorization', `Bearer ${userToken}`).send(body);

const setHandles = (facebook, instagram, linkedin) =>
    pool.query(
        'UPDATE profiles SET facebook = $1, instagram = $2, linkedin = $3 WHERE user_id = $4',
        [facebook, instagram, linkedin, userId]
    );

// A ticket needs a paid order behind it (tickets.order_id is NOT NULL).
async function issueTicket(forUserId, eventId, razorpayRef) {
    const order = await pool.query(
        `INSERT INTO orders (user_id, event_id, status, base_price_paise, discount_paise,
                             subtotal_paise, gst_percentage, gst_paise, total_paise,
                             razorpay_order_id, expires_at)
         VALUES ($1, $2, 'paid', 50000, 0, 50000, 18, 9000, 59000, $3, now() + interval '10 min')
         RETURNING id`,
        [forUserId, eventId, razorpayRef]
    );
    const ticket = await pool.query(
        'INSERT INTO tickets (order_id, user_id, event_id) VALUES ($1, $2, $3) RETURNING id',
        [order.rows[0].id, forUserId, eventId]
    );
    return { ticketId: ticket.rows[0].id, orderId: order.rows[0].id };
}

async function removeTicket({ ticketId, orderId }) {
    await pool.query('DELETE FROM tickets WHERE id = $1', [ticketId]);
    await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
}

const setRequirements = (eventId, fb, ig, li) =>
    pool.query(
        'UPDATE events SET require_facebook = $1, require_instagram = $2, require_linkedin = $3 WHERE id = $4',
        [fb, ig, li, eventId]
    );

beforeAll(async () => {
    const login = await request(app).post('/auth/login').send({ phone: USER_PHONE });
    userToken = login.body.token;
    const u = await pool.query('SELECT id FROM users WHERE phone = $1', [USER_PHONE]);
    userId = u.rows[0].id;
    await pool.query(
        `INSERT INTO profiles (user_id, first_name, last_name, gender, city_id, date_of_birth, email)
         VALUES ($1, 'Social', 'Tester', 'woman', 'del', '1997-06-01', 'social-tester@cirkle.live')
         ON CONFLICT (user_id) DO UPDATE SET first_name = 'Social'`,
        [userId]
    );

    await request(app).post('/auth/login').send({ phone: FILLER_PHONE });
    const filler = await pool.query('SELECT id FROM users WHERE phone = $1', [FILLER_PHONE]);
    fillerUserId = filler.rows[0].id;

    const orgHash = await bcrypt.hash(ORG_PASSWORD, 10);
    const org = await pool.query(
        `INSERT INTO organizers (email, password_hash, display_name)
         VALUES ($1, $2, 'Social Org') RETURNING id`,
        [ORG_EMAIL, orgHash]
    );
    orgId = org.rows[0].id;
    const orgLogin = await request(app).post('/organizer/auth/login').send({ email: ORG_EMAIL, password: ORG_PASSWORD });
    orgToken = orgLogin.body.token;

    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const admin = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ($1, $2, 'Social Admin', 'administrative') RETURNING id`,
        [ADMIN_EMAIL, adminHash]
    );
    adminId = admin.rows[0].id;
    const adminLogin = await request(app).post('/admin/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminToken = adminLogin.body.token;

    const openEvent = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size, organizer_id)
         VALUES ('Social Gate Open Event', 'club', 'del', now() + interval '25 days', 50000, 3, $1)
         RETURNING id`,
        [orgId]
    );
    openEventId = openEvent.rows[0].id;

    const inviteEvent = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size, event_type, organizer_id)
         VALUES ('Social Gate Invite Event', 'club', 'del', now() + interval '25 days', 50000, 3, 'invite_only', $1)
         RETURNING id`,
        [orgId]
    );
    inviteEventId = inviteEvent.rows[0].id;
});

afterAll(async () => {
    await pool.query('DELETE FROM event_invitations WHERE event_id = ANY($1)', [[openEventId, inviteEventId]]);
    await pool.query('DELETE FROM orders WHERE event_id = ANY($1)', [[openEventId, inviteEventId]]);
    await pool.query('DELETE FROM tickets WHERE event_id = ANY($1)', [[openEventId, inviteEventId]]);
    await pool.query('DELETE FROM audit_log WHERE entity_type = $1 AND entity_id = ANY($2)', ['event', [openEventId, inviteEventId]]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [[openEventId, inviteEventId]]);
    await pool.query('DELETE FROM organizers WHERE id = $1', [orgId]);
    await pool.query('DELETE FROM admins WHERE id = $1', [adminId]);
    await pool.query('DELETE FROM profiles WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[userId, fillerUserId]]);
    await pool.end();
});

describe('Handle normalization', () => {

    it('reduces Facebook forms to the bare handle, including profile.php ids', () => {
        expect(normalizeFacebook('https://www.facebook.com/zuck/')).toBe('zuck');
        expect(normalizeFacebook('fb.com/user.name')).toBe('user.name');
        expect(normalizeFacebook('@some.name')).toBe('some.name');
        expect(normalizeFacebook('facebook.com/profile.php?id=1234567890')).toBe('1234567890');
    });

    it('reduces LinkedIn forms to the bare vanity slug', () => {
        expect(normalizeLinkedin('https://www.linkedin.com/in/sayantan-roy/?originalSubdomain=in')).toBe('sayantan-roy');
        expect(normalizeLinkedin('linkedin.com/in/someone')).toBe('someone');
        expect(normalizeLinkedin('sayantan-roy')).toBe('sayantan-roy');
    });

    it('treats empty and null as null across all three', () => {
        for (const fn of [normalizeFacebook, normalizeInstagram, normalizeLinkedin]) {
            expect(fn('')).toBeNull();
            expect(fn('   ')).toBeNull();
            expect(fn(null)).toBeNull();
            expect(fn(undefined)).toBeNull();
        }
    });

    it('rejects implausible values rather than storing them', () => {
        expect(() => normalizeFacebook('not a name!')).toThrow('INVALID_HANDLE');
        expect(() => normalizeLinkedin('bad space')).toThrow('INVALID_HANDLE');
        expect(() => normalizeInstagram('user@example.com')).toThrow('INVALID_HANDLE');
    });

});

describe('checkRequiredHandles', () => {

    const ev = (facebook, instagram, linkedin) => ({
        require_facebook: facebook, require_instagram: instagram, require_linkedin: linkedin
    });

    it('is ok when the event requires nothing, even with no profile at all', () => {
        expect(checkRequiredHandles(ev(false, false, false), null)).toEqual({ ok: true, missing: [] });
    });

    it('lists exactly the required handles that are absent', () => {
        expect(checkRequiredHandles(ev(true, true, true), { facebook: 'a', instagram: null, linkedin: null }))
            .toEqual({ ok: false, missing: ['instagram', 'linkedin'] });
    });

    it('ignores handles the event does not require', () => {
        expect(checkRequiredHandles(ev(false, true, false), { facebook: null, instagram: 'x', linkedin: null }))
            .toEqual({ ok: true, missing: [] });
    });

    it('treats a whitespace-only handle as missing', () => {
        expect(checkRequiredHandles(ev(false, true, false), { instagram: '   ' }))
            .toEqual({ ok: false, missing: ['instagram'] });
    });

});

describe('PATCH /profile/me — social handles', () => {

    it('normalizes all three on write and returns them on GET', async () => {
        const res = await patchProfile({
            facebook: 'https://www.facebook.com/sayantan.roy/',
            instagram: '@sayantanroy',
            linkedin: 'https://www.linkedin.com/in/sayantan-roy/?originalSubdomain=in'
        });
        expect(res.status).toBe(200);

        const me = await request(app).get('/profile/me').set('Authorization', `Bearer ${userToken}`);
        expect(me.body.profile.facebook).toBe('sayantan.roy');
        expect(me.body.profile.instagram).toBe('sayantanroy');
        expect(me.body.profile.linkedin).toBe('sayantan-roy');

        const stored = await pool.query('SELECT facebook, instagram, linkedin FROM profiles WHERE user_id = $1', [userId]);
        expect(stored.rows[0]).toEqual({ facebook: 'sayantan.roy', instagram: 'sayantanroy', linkedin: 'sayantan-roy' });
    });

    it('clears a handle with an empty string', async () => {
        const res = await patchProfile({ facebook: '' });
        expect(res.status).toBe(200);

        const me = await request(app).get('/profile/me').set('Authorization', `Bearer ${userToken}`);
        expect(me.body.profile.facebook).toBeNull();
        // The others are untouched by a partial update
        expect(me.body.profile.instagram).toBe('sayantanroy');
    });

    it('rejects an invalid handle with 400 and names the platform', async () => {
        const res = await patchProfile({ linkedin: 'not a valid slug!!' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/linkedin/i);
    });

    it('leaves handles alone when they are not in the payload', async () => {
        await patchProfile({ facebook: 'restored.handle' });
        const res = await patchProfile({ tagline: 'Unrelated edit' });
        expect(res.status).toBe(200);

        const me = await request(app).get('/profile/me').set('Authorization', `Bearer ${userToken}`);
        expect(me.body.profile.facebook).toBe('restored.handle');
    });

});

describe('The gate — open event purchase', () => {

    it('blocks with 403 social_handles_required and the exact missing list', async () => {
        await setHandles(null, null, null);
        await setRequirements(openEventId, false, true, true);

        const res = await request(app)
            .post('/payments/orders')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ eventId: openEventId });

        expect(res.status).toBe(403);
        expect(res.body.error).toBe('social_handles_required');
        expect(res.body.missing).toEqual(['instagram', 'linkedin']);
    });

    it('lists only the handles still missing once some are supplied', async () => {
        await setHandles(null, 'someinsta', null);

        const res = await request(app)
            .post('/payments/orders')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ eventId: openEventId });

        expect(res.status).toBe(403);
        expect(res.body.missing).toEqual(['linkedin']);
    });

    // The gate must run ahead of the capacity check, so a user missing handles
    // is turned away by the handle error rather than a sold-out error.
    it('runs before the capacity gate', async () => {
        // Fill the event: capacity 1, taken by someone else. Without the
        // handle gate running first this request would 409 as sold out.
        await pool.query('UPDATE events SET capacity = 1 WHERE id = $1', [openEventId]);
        const filler = await issueTicket(fillerUserId, openEventId, 'order_social_filler');

        const res = await request(app)
            .post('/payments/orders')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ eventId: openEventId });

        expect(res.status).toBe(403);
        expect(res.body.error).toBe('social_handles_required');

        await removeTicket(filler);
        await pool.query('UPDATE events SET capacity = NULL WHERE id = $1', [openEventId]);
    });

    it('passes the gate once every required handle is present', async () => {
        await setHandles(null, 'someinsta', 'some-slug');

        const res = await request(app)
            .post('/payments/orders')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ eventId: openEventId });

        // Past the gate. Anything other than the handle 403 proves it — the
        // order may still fail downstream on Razorpay config in CI.
        expect(res.body.error).not.toBe('social_handles_required');
        expect(res.status).not.toBe(403);
    });

    it('does not gate at all when the event requires nothing', async () => {
        await setRequirements(openEventId, false, false, false);
        await setHandles(null, null, null);

        const res = await request(app)
            .post('/payments/orders')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ eventId: openEventId });

        expect(res.body.error).not.toBe('social_handles_required');
    });

});

describe('The gate — invite-only invitation request', () => {

    it('blocks the request before any invitation row is created', async () => {
        await setRequirements(inviteEventId, true, false, false);
        await setHandles(null, 'someinsta', 'some-slug');

        const res = await request(app)
            .post(`/events/${inviteEventId}/invitations`)
            .set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(403);
        expect(res.body.error).toBe('social_handles_required');
        expect(res.body.missing).toEqual(['facebook']);

        // Nothing was written — this is what guarantees the organizer only
        // ever sees requests that already carry the required handles.
        const rows = await pool.query(
            'SELECT id FROM event_invitations WHERE user_id = $1 AND event_id = $2',
            [userId, inviteEventId]
        );
        expect(rows.rows.length).toBe(0);
    });

    it('allows the request once the handle is supplied', async () => {
        await setHandles('my.facebook', 'someinsta', 'some-slug');

        const res = await request(app)
            .post(`/events/${inviteEventId}/invitations`)
            .set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(201);
        expect(res.body.status).toBe('pending');
    });

});

describe('Requirements are not retroactive', () => {

    it('a ticket bought before a requirement was added stays valid', async () => {
        await setRequirements(openEventId, false, false, false);
        await setHandles(null, null, null);

        const ticket = await issueTicket(userId, openEventId, 'order_social_retro');

        // Requirement added AFTER the ticket exists
        await setRequirements(openEventId, true, true, true);

        const stillThere = await pool.query('SELECT id FROM tickets WHERE id = $1', [ticket.ticketId]);
        expect(stillThere.rows.length).toBe(1);

        // And the user can still read the event — the gate only guards
        // purchase and request, not access to what they already hold.
        const res = await request(app)
            .get(`/events/${openEventId}`)
            .set('Authorization', `Bearer ${userToken}`);
        expect(res.status).toBe(200);
        expect(res.body.event.userHasTicket).toBe(true);

        await removeTicket(ticket);
    });

});

describe('Consumer GET /events/:id exposes the requirement flags', () => {

    it('returns all three booleans', async () => {
        await setRequirements(openEventId, true, false, true);

        const res = await request(app)
            .get(`/events/${openEventId}`)
            .set('Authorization', `Bearer ${userToken}`);

        expect(res.status).toBe(200);
        expect(res.body.event.requireFacebook).toBe(true);
        expect(res.body.event.requireInstagram).toBe(false);
        expect(res.body.event.requireLinkedin).toBe(true);
    });

});

describe('Admin can set requirements, and the change is audited', () => {

    it('PATCH sets the flags and records a from/to diff', async () => {
        await setRequirements(openEventId, false, false, false);

        const res = await request(app)
            .patch(`/admin/events/${openEventId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ requireInstagram: true });

        expect(res.status).toBe(200);
        expect(res.body.event.requireInstagram).toBe(true);

        const audit = await pool.query(
            `SELECT changes FROM audit_log
             WHERE entity_type = 'event' AND entity_id = $1 AND changes ? 'require_instagram'
             ORDER BY created_at DESC LIMIT 1`,
            [openEventId]
        );
        expect(audit.rows.length).toBe(1);
        expect(audit.rows[0].changes.require_instagram).toEqual({ from: false, to: true });
    });

    it('rejects a non-boolean flag', async () => {
        const res = await request(app)
            .patch(`/admin/events/${openEventId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ requireInstagram: 'yes' });
        expect(res.status).toBe(400);
    });

});

describe('Organizer cards — handles visible, contact info still not', () => {

    it('attendee cards carry the three handles and no phone/email', async () => {
        await setHandles('my.facebook', 'someinsta', 'some-slug');
        const ticket = await issueTicket(userId, openEventId, 'order_social_cards');

        const res = await request(app)
            .get(`/organizer/events/${openEventId}/attendees`)
            .set('Authorization', `Bearer ${orgToken}`);
        expect(res.status).toBe(200);

        const card = res.body.data.find(a => a.userId === userId);
        expect(card.facebook).toBe('my.facebook');
        expect(card.instagram).toBe('someinsta');
        expect(card.linkedin).toBe('some-slug');

        // The guarantee that must survive widening the SELECT.
        const raw = JSON.stringify(res.body);
        expect(raw).not.toContain(USER_PHONE);
        expect(raw).not.toContain('social-tester@cirkle.live');
        expect(raw).not.toMatch(/"phone"|"email"/);

        await removeTicket(ticket);
    });

    it('invitation cards carry them too, with the same guarantee', async () => {
        const res = await request(app)
            .get(`/organizer/events/${inviteEventId}/invitations`)
            .set('Authorization', `Bearer ${orgToken}`);
        expect(res.status).toBe(200);

        const card = res.body.data.find(i => i.userId === userId);
        expect(card).toBeDefined();
        expect(card.facebook).toBe('my.facebook');
        expect(card.instagram).toBe('someinsta');
        expect(card.linkedin).toBe('some-slug');

        const raw = JSON.stringify(res.body);
        expect(raw).not.toContain(USER_PHONE);
        expect(raw).not.toContain('social-tester@cirkle.live');
        expect(raw).not.toMatch(/"phone"|"email"/);
    });

    it('returns null handles for a user who has none, rather than omitting them', async () => {
        await setHandles(null, null, null);

        const res = await request(app)
            .get(`/organizer/events/${inviteEventId}/invitations`)
            .set('Authorization', `Bearer ${orgToken}`);

        const card = res.body.data.find(i => i.userId === userId);
        expect(card.facebook).toBeNull();
        expect(card.instagram).toBeNull();
        expect(card.linkedin).toBeNull();
    });

});
