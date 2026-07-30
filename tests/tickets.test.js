import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

const app = createApp();

const TEST_PHONE = '+916060606060';

let userId, token;
let eventWithBannerId, eventNoBannerId;
let ticketWithBannerId, ticketNoBannerId;

async function giveTicket(eventId) {
    const ord = await pool.query(
        `INSERT INTO orders (user_id, event_id, status, base_price_paise, discount_paise,
                             subtotal_paise, gst_percentage, gst_paise, total_paise,
                             razorpay_order_id, expires_at)
         VALUES ($1, $2, 'paid', 50000, 0, 50000, 18, 9000, 59000, $3, now() + interval '10 min')
         RETURNING id`,
        [userId, eventId, `order_test_${Math.random().toString(36).slice(2, 12)}`]
    );
    const tk = await pool.query(
        `INSERT INTO tickets (order_id, user_id, event_id) VALUES ($1, $2, $3) RETURNING id`,
        [ord.rows[0].id, userId, eventId]
    );
    return tk.rows[0].id;
}

beforeAll(async () => {
    const login = await request(app).post('/auth/login').send({ phone: TEST_PHONE });
    token = login.body.token;
    const u = await pool.query('SELECT id FROM users WHERE phone = $1', [TEST_PHONE]);
    userId = u.rows[0].id;

    const withBanner = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size, banner_s3_key)
         VALUES ('TEST Ticket Event With Banner', 'club', 'del', now() + interval '10 days', 50000, 3, 'events/test-fixture/banner/fake.jpg')
         RETURNING id`
    );
    eventWithBannerId = withBanner.rows[0].id;

    const noBanner = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size)
         VALUES ('TEST Ticket Event No Banner', 'club', 'del', now() + interval '10 days', 50000, 3)
         RETURNING id`
    );
    eventNoBannerId = noBanner.rows[0].id;

    ticketWithBannerId = await giveTicket(eventWithBannerId);
    ticketNoBannerId = await giveTicket(eventNoBannerId);
}, 30000);

afterAll(async () => {
    await pool.query('DELETE FROM tickets WHERE id = ANY($1)', [[ticketWithBannerId, ticketNoBannerId]]);
    await pool.query('DELETE FROM orders WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [[eventWithBannerId, eventNoBannerId]]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
});

describe('GET /tickets — banner handling', () => {

    it('requires auth', async () => {
        const res = await request(app).get('/tickets');
        expect(res.status).toBe(401);
    });

    it('returns a presigned bannerUrl, never a raw key, and is null-safe when the event has no banner', async () => {
        const res = await request(app)
            .get('/tickets')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);

        const withBanner = res.body.tickets.find(t => t.id === ticketWithBannerId);
        const noBanner = res.body.tickets.find(t => t.id === ticketNoBannerId);

        expect(withBanner.event.bannerUrl).toMatch(/^https:\/\//);
        expect(noBanner.event.bannerUrl).toBeNull();
        expect(JSON.stringify(res.body)).not.toMatch(/bannerS3Key|s3_key/);
    });

});

describe('GET /tickets/:id — banner handling', () => {

    it('returns a presigned bannerUrl for a ticket whose event has a banner', async () => {
        const res = await request(app)
            .get(`/tickets/${ticketWithBannerId}`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.ticket.event.bannerUrl).toMatch(/^https:\/\//);
        expect(JSON.stringify(res.body)).not.toMatch(/bannerS3Key|s3_key/);
    });

    it('returns null bannerUrl, not an error, for a ticket whose event has no banner', async () => {
        const res = await request(app)
            .get(`/tickets/${ticketNoBannerId}`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.ticket.event.bannerUrl).toBeNull();
    });

});
