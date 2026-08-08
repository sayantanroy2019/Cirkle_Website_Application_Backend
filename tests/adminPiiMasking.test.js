import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { maskPhone, maskEmail, userContactFor } from '../src/utils/adminPii.js';
import { can } from '../src/utils/permissions.js';

const app = createApp();

const ADMIN_EMAIL = 'zzpii-admin@cirkle.live';
const BD_EMAIL = 'zzpii-bd@cirkle.live';
const PASSWORD = 'PiiMaskPass123!';

// Distinctive and greppable. If either ever appears in a BD response, the
// assertions below fail on the VALUE, not merely on a field name.
const USER_PHONE = '+919333333301';
const USER_EMAIL = 'must-not-leak-to-bd@cirkle.live';

let adminId, bdId, adminToken, bdToken;
let userId, eventId, orderId, ticketId, invitationId;

const asAdmin = path => request(app).get(path).set('Authorization', `Bearer ${adminToken}`);
const asBd    = path => request(app).get(path).set('Authorization', `Bearer ${bdToken}`);

// Every admin surface that carries end-user contact details.
const SURFACES = () => [
    { name: 'GET /admin/users',            path: '/admin/users?limit=100' },
    { name: 'GET /admin/users/:id',        path: `/admin/users/${userId}` },
    { name: 'GET /admin/orders',           path: `/admin/orders?userId=${userId}&limit=100` },
    { name: 'GET /admin/orders/:id',       path: `/admin/orders/${orderId}` },
    { name: 'GET /admin/tickets',          path: `/admin/tickets?userId=${userId}&limit=100` },
    { name: 'GET /admin/tickets/:id',      path: `/admin/tickets/${ticketId}` },
    { name: 'GET /admin/invitations',      path: `/admin/invitations?userId=${userId}&limit=100` }
];

beforeAll(async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const a = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ($1, $2, 'PII Admin', 'administrative') RETURNING id`, [ADMIN_EMAIL, hash]);
    adminId = a.rows[0].id;
    const b = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ($1, $2, 'PII BD', 'business_development') RETURNING id`, [BD_EMAIL, hash]);
    bdId = b.rows[0].id;

    adminToken = (await request(app).post('/admin/auth/login').send({ email: ADMIN_EMAIL, password: PASSWORD })).body.token;
    bdToken    = (await request(app).post('/admin/auth/login').send({ email: BD_EMAIL,    password: PASSWORD })).body.token;

    await request(app).post('/auth/login').send({ phone: USER_PHONE });
    userId = (await pool.query('SELECT id FROM users WHERE phone = $1', [USER_PHONE])).rows[0].id;
    await pool.query(
        `INSERT INTO profiles (user_id, first_name, last_name, gender, city_id, date_of_birth, email)
         VALUES ($1, 'Pii', 'Tester', 'woman', 'del', '1996-05-05', $2)
         ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, first_name = 'Pii'`,
        [userId, USER_EMAIL]
    );

    const ev = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size, event_type)
         VALUES ('ZZPii Event', 'club', 'del', now() + interval '15 days', 0, 2, 'invite_only') RETURNING id`
    );
    eventId = ev.rows[0].id;

    const o = await pool.query(
        `INSERT INTO orders (user_id, event_id, status, base_price_paise, discount_paise,
                             subtotal_paise, gst_percentage, gst_paise, total_paise,
                             razorpay_order_id, expires_at)
         VALUES ($1, $2, 'paid', 50000, 0, 50000, 18, 9000, 59000, 'order_zzpii', now() + interval '10 min')
         RETURNING id`, [userId, eventId]);
    orderId = o.rows[0].id;

    const t = await pool.query(
        `INSERT INTO tickets (order_id, user_id, event_id) VALUES ($1, $2, $3) RETURNING id`,
        [orderId, userId, eventId]);
    ticketId = t.rows[0].id;

    const inv = await pool.query(
        `INSERT INTO event_invitations (user_id, event_id, status) VALUES ($1, $2, 'pending') RETURNING id`,
        [userId, eventId]);
    invitationId = inv.rows[0].id;
});

afterAll(async () => {
    await pool.query('DELETE FROM event_invitations WHERE id = $1', [invitationId]);
    await pool.query('DELETE FROM tickets WHERE id = $1', [ticketId]);
    await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
    await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
    await pool.query('DELETE FROM profiles WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query('DELETE FROM admins WHERE id = ANY($1)', [[adminId, bdId]]);
    await pool.end();
});

describe('The capability', () => {

    it('gives view_pii to administrative and withholds it from business_development', () => {
        expect(can({ role: 'administrative' }, 'view_pii')).toBe(true);
        expect(can({ role: 'business_development' }, 'view_pii')).toBe(false);
    });

    it('leaves the other capabilities untouched', () => {
        expect(can({ role: 'business_development' }, 'manage_events')).toBe(true);
        expect(can({ role: 'business_development' }, 'manage_admins')).toBe(false);
        expect(can({ role: 'administrative' }, 'manage_admins')).toBe(true);
    });

});

describe('The masking functions', () => {

    it('keeps the country code and last three digits of a phone', () => {
        expect(maskPhone('+919876543210')).toBe('+91******210');
        expect(maskPhone('9876543210')).toBe('******210');
    });

    it('hides the real length — the mask is fixed width', () => {
        expect(maskPhone('+911111111111')).toBe('+91******111');
        expect(maskPhone('+9122222')).toBe('+91******222');
    });

    it('keeps the first character and the domain of an email', () => {
        expect(maskEmail('jane.doe@gmail.com')).toBe('j****@gmail.com');
        expect(maskEmail('a@b.co')).toBe('a****@b.co');
    });

    it('handles null, empty and malformed values without throwing', () => {
        expect(maskPhone(null)).toBeNull();
        expect(maskEmail(null)).toBeNull();
        expect(maskPhone('12')).toBe('******');
        expect(maskEmail('notanemail')).toBe('****');
        expect(maskEmail('@nolocal.com')).toBe('****');
    });

    it('returns real values only for a capability holder', () => {
        const contact = { phone: '+919876543210', email: 'jane@x.com' };
        expect(userContactFor({ role: 'administrative' }, contact)).toEqual(contact);
        expect(userContactFor({ role: 'business_development' }, contact))
            .toEqual({ phone: '+91******210', email: 'j****@x.com' });
    });

    it('omits a field that was not asked for', () => {
        expect(userContactFor({ role: 'business_development' }, { phone: '+919876543210' }))
            .toEqual({ phone: '+91******210' });
    });

});

describe('administrative sees real contact details', () => {

    it('on the users list and detail', async () => {
        const list = await asAdmin('/admin/users?search=' + encodeURIComponent(USER_PHONE));
        const row = list.body.data.find(u => u.id === userId);
        expect(row.phone).toBe(USER_PHONE);
        expect(row.email).toBe(USER_EMAIL);

        const detail = await asAdmin(`/admin/users/${userId}`);
        expect(detail.body.user.phone).toBe(USER_PHONE);
        expect(detail.body.user.email).toBe(USER_EMAIL);
    });

    it('on orders, tickets and invitations', async () => {
        expect((await asAdmin(`/admin/orders/${orderId}`)).body.order.user.phone).toBe(USER_PHONE);
        expect((await asAdmin(`/admin/tickets/${ticketId}`)).body.ticket.user.phone).toBe(USER_PHONE);

        const inv = await asAdmin(`/admin/invitations?userId=${userId}`);
        expect(inv.body.data[0].user.phone).toBe(USER_PHONE);
    });

});

describe('business_development sees masked contact details', () => {

    it('gets the masked forms on the users list and detail', async () => {
        const list = await asBd('/admin/users?search=' + encodeURIComponent(USER_PHONE));
        const row = list.body.data.find(u => u.id === userId);
        expect(row.phone).toBe(maskPhone(USER_PHONE));
        expect(row.email).toBe(maskEmail(USER_EMAIL));

        const detail = await asBd(`/admin/users/${userId}`);
        expect(detail.body.user.phone).toBe(maskPhone(USER_PHONE));
        expect(detail.body.user.email).toBe(maskEmail(USER_EMAIL));
    });

    it('gets the masked phone on orders, tickets and invitations', async () => {
        expect((await asBd(`/admin/orders/${orderId}`)).body.order.user.phone).toBe(maskPhone(USER_PHONE));
        expect((await asBd(`/admin/tickets/${ticketId}`)).body.ticket.user.phone).toBe(maskPhone(USER_PHONE));

        const inv = await asBd(`/admin/invitations?userId=${userId}`);
        expect(inv.body.data[0].user.phone).toBe(maskPhone(USER_PHONE));
    });

    // THE assertion this feature exists for. Masking client-side would leave
    // the real value in the network tab; this proves it never leaves the
    // server. Checked on the raw response text of every surface.
    it('never sends the real phone or email in ANY response body', async () => {
        for (const surface of SURFACES()) {
            const res = await asBd(surface.path);
            expect(res.status, `${surface.name} did not return 200`).toBe(200);

            const raw = JSON.stringify(res.body);
            expect(raw, `${surface.name} leaked the real phone`).not.toContain(USER_PHONE);
            expect(raw, `${surface.name} leaked the real email`).not.toContain(USER_EMAIL);

            // Not merely absent because the user is missing from the payload.
            expect(raw, `${surface.name} did not include the user at all`).toContain(userId);
        }
    });

    it('by contrast, administrative DOES receive them on those same surfaces', async () => {
        const leaks = [];
        for (const surface of SURFACES()) {
            const raw = JSON.stringify((await asAdmin(surface.path)).body);
            if (raw.includes(USER_PHONE)) leaks.push(surface.name);
        }
        // Every surface carries a phone, so all of them should show it.
        expect(leaks.length).toBe(SURFACES().length);
    });

});

describe('Search still works for BD, with masked results', () => {

    it('finds the user by full phone, and still masks the result', async () => {
        const res = await asBd('/admin/users?search=' + encodeURIComponent(USER_PHONE));
        expect(res.status).toBe(200);

        const row = res.body.data.find(u => u.id === userId);
        expect(row, 'BD search by phone should still find the user').toBeDefined();
        expect(row.phone).toBe(maskPhone(USER_PHONE));
        expect(JSON.stringify(res.body)).not.toContain(USER_PHONE);
    });

    it('finds the user by email fragment, still masked', async () => {
        const res = await asBd('/admin/users?search=must-not-leak-to-bd');
        const row = res.body.data.find(u => u.id === userId);
        expect(row).toBeDefined();
        expect(row.email).toBe(maskEmail(USER_EMAIL));
    });

    it('finds the user by name, still masked', async () => {
        const res = await asBd('/admin/users?search=Pii');
        const row = res.body.data.find(u => u.id === userId);
        expect(row).toBeDefined();
        expect(row.phone).toBe(maskPhone(USER_PHONE));
    });

});

describe('Out of scope — deliberately unchanged', () => {

    it('staff login emails stay visible to BD (they are identities, not end-user PII)', async () => {
        const res = await request(app).get('/admin/organizers')
            .set('Authorization', `Bearer ${bdToken}`);
        expect(res.status).toBe(200);
        // Organizer emails are login identities for staff, not end-user contact
        // details — B7 does not touch them.
        expect(res.body.organizers.every(o => typeof o.email === 'string')).toBe(true);
    });

    it('organizer-facing attendee data still selects no phone or email', async () => {
        // Stronger than masking: the SQL never selects them, so there is
        // nothing to mask. Unchanged by B7 — asserted on the column list with
        // SQL comments stripped, since the comment there discusses the very
        // words being searched for.
        const { readFileSync } = await import('fs');
        const src = readFileSync('src/utils/organizerAttendee.js', 'utf8');
        const columns = src
            .slice(src.indexOf('SELECT'), src.indexOf('FROM profiles'))
            .split('\n')
            .filter(line => !line.trim().startsWith('--'))
            .join('\n');

        expect(columns).not.toMatch(/\bphone\b/);
        expect(columns).not.toMatch(/\bemail\b/);
        // Sanity: the slice really is the column list.
        expect(columns).toMatch(/first_name/);
    });

});
