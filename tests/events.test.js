import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

const app = createApp();

const TEST_PHONE = '+916666666666';
let token;

beforeAll(async () => {
    // Create test user and complete onboarding up to city (step 4)
    // so GET /events has a profile city to default to
    const loginRes = await request(app)
        .post('/auth/login')
        .send({ phone: TEST_PHONE });
    token = loginRes.body.token;

    await request(app)
        .patch('/onboarding/step/1')
        .set('Authorization', `Bearer ${token}`)
        .send({ firstName: 'Test', lastName: 'User' });

    await request(app)
        .patch('/onboarding/step/2')
        .set('Authorization', `Bearer ${token}`)
        .send({ dateOfBirth: '1995-01-01' });

    await request(app)
        .patch('/onboarding/step/3')
        .set('Authorization', `Bearer ${token}`)
        .send({ gender: 'man' });

    await request(app)
        .patch('/onboarding/step/4')
        .set('Authorization', `Bearer ${token}`)
        .send({ cityId: 'del' });
});

afterAll(async () => {
    await pool.query('DELETE FROM users WHERE phone = $1', [TEST_PHONE]);
    await pool.end();
});

// ─── GET /events ──────────────────────────────────────────────────────
describe('GET /events', () => {

    it('returns 401 with no token', async () => {
        const res = await request(app).get('/events');
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('No token provided');
    });

    it('returns events for profile city by default', async () => {
        const res = await request(app)
            .get('/events')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.events)).toBe(true);
        expect(res.body.events.length).toBeGreaterThan(0);
        // all events should be for Delhi NCR
        res.body.events.forEach(e => {
            expect(e.cityId).toBe('del');
        });
    });

    it('returns empty array for city with no events', async () => {
        const res = await request(app)
            .get('/events?city=mum')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.events).toEqual([]);
    });

    it('filters by category', async () => {
        const res = await request(app)
            .get('/events?category=concert')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.events.length).toBeGreaterThan(0);
        res.body.events.forEach(e => {
            expect(e.categoryId).toBe('concert');
        });
    });

    it('filters by city and category combined', async () => {
        const res = await request(app)
            .get('/events?city=del&category=club')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        res.body.events.forEach(e => {
            expect(e.cityId).toBe('del');
            expect(e.categoryId).toBe('club');
        });
    });

    it('returns 400 for invalid city', async () => {
        const res = await request(app)
            .get('/events?city=xyz')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid city');
    });

    it('returns 400 for invalid category', async () => {
        const res = await request(app)
            .get('/events?category=xyz')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid category');
    });

});
// ─── GET /events/:id ──────────────────────────────────────────────────
describe('GET /events/:id', () => {

    let eventId;

    beforeAll(async () => {
        // Grab a real event ID from the DB to test against
        const result = await pool.query(
            'SELECT id FROM events WHERE city_id = $1 LIMIT 1',
            ['del']
        );
        eventId = result.rows[0].id;
    });

    it('returns 401 with no token', async () => {
        const res = await request(app).get(`/events/${eventId}`);
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('No token provided');
    });

    it('returns event detail for valid ID', async () => {
        const res = await request(app)
            .get(`/events/${eventId}`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.event).toBeDefined();
        expect(res.body.event.id).toBe(eventId);
        expect(res.body.event.name).toBeDefined();
        expect(res.body.event.price).toBeDefined();
        expect(res.body.event.targetGroupSize).toBeDefined();
    });

    it('returns 404 for non-existent event', async () => {
        const res = await request(app)
            .get('/events/00000000-0000-0000-0000-000000000000')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Event not found');
    });

});