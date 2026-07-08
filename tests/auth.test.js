import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

const app = createApp();

const TEST_PHONE = '+918888888888'; // unique test phone — never used by real users

// Clean up after all tests run
afterAll(async () => {
    await pool.query('DELETE FROM users WHERE phone = $1', [TEST_PHONE]);
    await pool.end();
});

describe('POST /auth/login', () => {

    it('returns 400 for missing phone', async () => {
        const res = await request(app)
            .post('/auth/login')
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid phone number');
    });

    it('returns 400 for invalid phone format', async () => {
        const res = await request(app)
            .post('/auth/login')
            .send({ phone: '9876543210' }); // missing +91
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid phone number');
    });

    it('creates new user and returns token', async () => {
        const res = await request(app)
            .post('/auth/login')
            .send({ phone: TEST_PHONE });
        expect(res.status).toBe(200);
        expect(res.body.token).toBeDefined();
        expect(res.body.isNewUser).toBe(true);
        expect(res.body.currentOnboardingStep).toBe(0);
        expect(res.body.partialProfileComplete).toBe(false);
    });

    it('returns existing user on second login', async () => {
        const res = await request(app)
            .post('/auth/login')
            .send({ phone: TEST_PHONE });
        expect(res.status).toBe(200);
        expect(res.body.token).toBeDefined();
        expect(res.body.isNewUser).toBe(false);
        expect(res.body.currentOnboardingStep).toBe(0);
    });

});