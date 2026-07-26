import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

const app = createApp();

const TEST_PHONE = '+916464646464';
let token;
let userId;
let inviteOnlyEventId;
let openEventId;

beforeAll(async () => {
    // A user, onboarded far enough to have a city (needed by some event reads)
    const login = await request(app).post('/auth/login').send({ phone: TEST_PHONE });
    token = login.body.token;
    const u = await pool.query('SELECT id FROM users WHERE phone = $1', [TEST_PHONE]);
    userId = u.rows[0].id;

    // Our own invite-only event, so the test doesn't depend on seeded state
    const invite = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size, event_type)
         VALUES ('TEST Invite-Only', 'club', 'del', now() + interval '30 days', 50000, 3, 'invite_only')
         RETURNING id`
    );
    inviteOnlyEventId = invite.rows[0].id;

    // And an open one, to prove the endpoint rejects invitations on open events
    const open = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size, event_type)
         VALUES ('TEST Open', 'club', 'del', now() + interval '30 days', 50000, 3, 'open')
         RETURNING id`
    );
    openEventId = open.rows[0].id;
});

afterAll(async () => {
    // Order matters: invitations and orders reference events/users
    await pool.query('DELETE FROM event_invitations WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM orders WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [[inviteOnlyEventId, openEventId]]);
    await pool.query('DELETE FROM users WHERE phone = $1', [TEST_PHONE]);
    await pool.end();
});

describe('POST /events/:id/invitations', () => {

    it('rejects an invitation request on an OPEN event', async () => {
        const res = await request(app)
            .post(`/events/${openEventId}/invitations`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('This event does not require an invitation');
    });

    it('creates a pending invitation on an invite-only event', async () => {
        const res = await request(app)
            .post(`/events/${inviteOnlyEventId}/invitations`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('pending');
    });

    it('blocks a second request while pending', async () => {
        const res = await request(app)
            .post(`/events/${inviteOnlyEventId}/invitations`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(409);
        expect(res.body.status).toBe('pending');
    });

    it('returns 404 for a nonexistent event', async () => {
        const res = await request(app)
            .post('/events/00000000-0000-0000-0000-000000000000/invitations')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(404);
    });

    it('requires auth', async () => {
        const res = await request(app).post(`/events/${inviteOnlyEventId}/invitations`);
        expect(res.status).toBe(401);
    });
});

describe('GET /events/:id — invitation status surfacing', () => {

    it('reports eventType and pending invitationStatus', async () => {
        const res = await request(app)
            .get(`/events/${inviteOnlyEventId}`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.event.eventType).toBe('invite_only');
        expect(res.body.event.invitationStatus).toBe('pending');
    });

    it('reports null invitationStatus on an open event', async () => {
        const res = await request(app)
            .get(`/events/${openEventId}`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.body.event.eventType).toBe('open');
        expect(res.body.event.invitationStatus).toBeNull();
    });
});

describe('POST /payments/orders — the invite-only gate', () => {

    it('returns 403 when the invitation is still pending', async () => {
        const res = await request(app)
            .post('/payments/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({ eventId: inviteOnlyEventId });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/accepted invitation is required/i);
    });

    it('returns 403 after the invitation is REJECTED', async () => {
        // Organizer rejects (simulated via direct DB write)
        await pool.query(
            `UPDATE event_invitations SET status = 'rejected', updated_at = now()
             WHERE user_id = $1 AND event_id = $2`,
            [userId, inviteOnlyEventId]
        );
        const res = await request(app)
            .post('/payments/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({ eventId: inviteOnlyEventId });
        expect(res.status).toBe(403);
    });

    it('allows order creation once the invitation is ACCEPTED', async () => {
        // Organizer accepts (simulated). Overriding the rejected row directly,
        // since the real terminal-state guard lives in the manual SQL path.
        await pool.query(
            `UPDATE event_invitations SET status = 'accepted', updated_at = now()
             WHERE user_id = $1 AND event_id = $2`,
            [userId, inviteOnlyEventId]
        );
        const res = await request(app)
            .post('/payments/orders')
            .set('Authorization', `Bearer ${token}`)
            .send({ eventId: inviteOnlyEventId });
        expect(res.status).toBe(201);
        expect(res.body.razorpayOrderId).toMatch(/^order_/);
    });
});