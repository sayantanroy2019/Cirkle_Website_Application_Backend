import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

const app = createApp();

const TEST_PHONE = '+917777777777';
let token;
let lifestyleTagIds;

// Create a test user and get a token before all tests
beforeAll(async () => {
    const res = await request(app)
        .post('/auth/login')
        .send({ phone: TEST_PHONE });
    token = res.body.token;

    // Fetch real tag IDs from DB for step 5 tests
    const tags = await pool.query('SELECT id FROM lifestyle_tags LIMIT 5');
    lifestyleTagIds = tags.rows.map(r => r.id);
});

// Clean up test user after all tests
afterAll(async () => {
    await pool.query('DELETE FROM users WHERE phone = $1', [TEST_PHONE]);
    await pool.end();
});

// ─── GET /onboarding/status ───────────────────────────────────────────
describe('GET /onboarding/status', () => {

    it('returns 401 with no token', async () => {
        const res = await request(app).get('/onboarding/status');
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('No token provided');
    });

    it('returns current step and gate flag', async () => {
        const res = await request(app)
            .get('/onboarding/status')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.currentOnboardingStep).toBe(0);
        expect(res.body.partialProfileComplete).toBe(false);
    });

});

// ─── PATCH /onboarding/step/1 ─────────────────────────────────────────
describe('PATCH /onboarding/step/1 — name', () => {

    it('returns 400 for missing name', async () => {
        const res = await request(app)
            .patch('/onboarding/step/1')
            .set('Authorization', `Bearer ${token}`)
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('First name and last name are required');
    });

    it('returns 400 for empty-string name', async () => {
        const res = await request(app)
            .patch('/onboarding/step/1')
            .set('Authorization', `Bearer ${token}`)
            .send({ firstName: '', lastName: 'Roy' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('First name and last name are required');
    });

    it('saves name and advances step', async () => {
        const res = await request(app)
            .patch('/onboarding/step/1')
            .set('Authorization', `Bearer ${token}`)
            .send({ firstName: 'Sayantan', lastName: 'Roy' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.currentOnboardingStep).toBe(1);
    });

});

// ─── PATCH /onboarding/step/2 ─────────────────────────────────────────
describe('PATCH /onboarding/step/2 — date of birth', () => {

    it('returns 400 for missing DOB', async () => {
        const res = await request(app)
            .patch('/onboarding/step/2')
            .set('Authorization', `Bearer ${token}`)
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Date of birth is required');
    });

    it('returns 400 for invalid date format', async () => {
        const res = await request(app)
            .patch('/onboarding/step/2')
            .set('Authorization', `Bearer ${token}`)
            .send({ dateOfBirth: 'not-a-date' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid date format. Use YYYY-MM-DD');
    });

    it('saves DOB and advances step', async () => {
        const res = await request(app)
            .patch('/onboarding/step/2')
            .set('Authorization', `Bearer ${token}`)
            .send({ dateOfBirth: '2000-05-15' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.currentOnboardingStep).toBe(2);
    });

});

// ─── PATCH /onboarding/step/3 ─────────────────────────────────────────
describe('PATCH /onboarding/step/3 — gender', () => {

    it('returns 400 for invalid gender', async () => {
        const res = await request(app)
            .patch('/onboarding/step/3')
            .set('Authorization', `Bearer ${token}`)
            .send({ gender: 'male' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Gender must be one of: man, woman, non_binary, prefer_not_to_say');
    });

    it('saves gender and advances step', async () => {
        const res = await request(app)
            .patch('/onboarding/step/3')
            .set('Authorization', `Bearer ${token}`)
            .send({ gender: 'man' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.currentOnboardingStep).toBe(3);
    });

});

// ─── PATCH /onboarding/step/4 ─────────────────────────────────────────
describe('PATCH /onboarding/step/4 — city', () => {

    it('returns 400 for invalid city', async () => {
        const res = await request(app)
            .patch('/onboarding/step/4')
            .set('Authorization', `Bearer ${token}`)
            .send({ cityId: 'xyz' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid city');
    });

    it('saves city and advances step', async () => {
        const res = await request(app)
            .patch('/onboarding/step/4')
            .set('Authorization', `Bearer ${token}`)
            .send({ cityId: 'del' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.currentOnboardingStep).toBe(4);
    });

});

// ─── PATCH /onboarding/step/5 ─────────────────────────────────────────
describe('PATCH /onboarding/step/5 — lifestyle tags', () => {

    it('returns 400 for too few tags', async () => {
        const res = await request(app)
            .patch('/onboarding/step/5')
            .set('Authorization', `Bearer ${token}`)
            .send({ lifestyleTagIds: [lifestyleTagIds[0], lifestyleTagIds[1]] });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Select between 3 and 5 lifestyle tags');
    });

    it('returns 400 for too many tags', async () => {
        const res = await request(app)
            .patch('/onboarding/step/5')
            .set('Authorization', `Bearer ${token}`)
            .send({ lifestyleTagIds: [...lifestyleTagIds, 'extra-1', 'extra-2'] });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Select between 3 and 5 lifestyle tags');
    });

    it('returns 400 for invalid tag ID format', async () => {
        const res = await request(app)
            .patch('/onboarding/step/5')
            .set('Authorization', `Bearer ${token}`)
            .send({ lifestyleTagIds: [lifestyleTagIds[0], lifestyleTagIds[1], 'not-a-uuid'] });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('One or more invalid lifestyle tags');
    });

    it('saves tags and advances step', async () => {
        const res = await request(app)
            .patch('/onboarding/step/5')
            .set('Authorization', `Bearer ${token}`)
            .send({ lifestyleTagIds: [lifestyleTagIds[0], lifestyleTagIds[1], lifestyleTagIds[2]] });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.currentOnboardingStep).toBe(5);
    });

});

// ─── PATCH /onboarding/step/6 ─────────────────────────────────────────
describe('PATCH /onboarding/step/6 — photos (stubbed)', () => {

    it('returns 400 for too few photos', async () => {
        const res = await request(app)
            .patch('/onboarding/step/6')
            .set('Authorization', `Bearer ${token}`)
            .send({ photos: [{ s3Key: 'profiles/test/photo-0.jpg', position: 0 }] });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Upload between 2 and 4 photos');
    });

    it('returns 400 for missing main photo', async () => {
        const res = await request(app)
            .patch('/onboarding/step/6')
            .set('Authorization', `Bearer ${token}`)
            .send({ photos: [
                { s3Key: 'profiles/test/photo-1.jpg', position: 1 },
                { s3Key: 'profiles/test/photo-2.jpg', position: 2 }
            ]});
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('A main photo (position 0) is required');
    });

    it('saves photos and advances step', async () => {
        const res = await request(app)
            .patch('/onboarding/step/6')
            .set('Authorization', `Bearer ${token}`)
            .send({ photos: [
                { s3Key: 'profiles/test/photo-0.jpg', position: 0 },
                { s3Key: 'profiles/test/photo-1.jpg', position: 1 }
            ]});
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.currentOnboardingStep).toBe(6);
    });

});

// ─── PATCH /onboarding/step/7 ─────────────────────────────────────────
describe('PATCH /onboarding/step/7 — email', () => {

    it('returns 400 for invalid email', async () => {
        const res = await request(app)
            .patch('/onboarding/step/7')
            .set('Authorization', `Bearer ${token}`)
            .send({ email: 'notanemail' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid email format');
    });

    it('saves email, advances step, unlocks Feed', async () => {
        const res = await request(app)
            .patch('/onboarding/step/7')
            .set('Authorization', `Bearer ${token}`)
            .send({ email: 'test@cirkle.live' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.currentOnboardingStep).toBe(7);
        expect(res.body.partialProfileComplete).toBe(true);
    });

    it('status confirms onboarding complete', async () => {
        const res = await request(app)
            .get('/onboarding/status')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.currentOnboardingStep).toBe(7);
        expect(res.body.partialProfileComplete).toBe(true);
    });

});