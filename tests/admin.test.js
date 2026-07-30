import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

const app = createApp();

const ADMIN_EMAIL = 'test-admin-suite@cirkle.live';
const ADMIN_PASSWORD = 'AdminSuitePass123!';
const USER_PHONE = '+916262626262';
const BD_EMAIL = 'test-bd-suite@cirkle.live';
const BD_PASSWORD = 'BdSuitePass123!';

let adminId, adminToken, userToken;
const createdAdminIds = [];

// The very first admin has no creator — bootstrap directly via DB, same as
// scripts/seed-admin.js does. Every admin after this one goes through the API.
beforeAll(async () => {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const inserted = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ($1, $2, 'Test Suite Admin', 'administrative')
         RETURNING id`,
        [ADMIN_EMAIL, passwordHash]
    );
    adminId = inserted.rows[0].id;
    createdAdminIds.push(adminId);

    const loginRes = await request(app)
        .post('/admin/auth/login')
        .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminToken = loginRes.body.token;

    const userLogin = await request(app)
        .post('/auth/login')
        .send({ phone: USER_PHONE });
    userToken = userLogin.body.token;
}, 30000);

afterAll(async () => {
    await pool.query('DELETE FROM admins WHERE id = ANY($1)', [createdAdminIds]);
    await pool.query('DELETE FROM users WHERE phone = $1', [USER_PHONE]);
    await pool.end();
});

describe('POST /admin/auth/login', () => {

    it('returns 400 for missing credentials', async () => {
        const res = await request(app).post('/admin/auth/login').send({});
        expect(res.status).toBe(400);
    });

    it('returns a token for valid credentials', async () => {
        const res = await request(app)
            .post('/admin/auth/login')
            .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
        expect(res.status).toBe(200);
        expect(res.body.token).toBeDefined();
        expect(res.body.admin.email).toBe(ADMIN_EMAIL);
        expect(res.body.admin.role).toBe('administrative');
        expect(JSON.stringify(res.body)).not.toMatch(/password_hash/);
    });

    it('returns a generic 401 for a wrong password', async () => {
        const res = await request(app)
            .post('/admin/auth/login')
            .send({ email: ADMIN_EMAIL, password: 'wrong-password' });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Invalid credentials');
    });

    it('returns the SAME generic 401 for a nonexistent email', async () => {
        const res = await request(app)
            .post('/admin/auth/login')
            .send({ email: 'nobody-at-all@cirkle.live', password: 'whatever123' });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Invalid credentials');
    });

});

describe('Token separation between users and admins', () => {

    it('rejects a user (attendee) JWT on an admin route', async () => {
        const res = await request(app)
            .get('/admin/admins')
            .set('Authorization', `Bearer ${userToken}`);
        expect(res.status).toBe(401);
    });

    it('rejects an admin JWT on a user route', async () => {
        const res = await request(app)
            .get('/profile/me')
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(401);
    });

});

describe('Admin account management (manage_admins capability)', () => {
    let bdId, bdToken;

    it('an administrative admin can create a business_development admin', async () => {
        const res = await request(app)
            .post('/admin/admins')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ email: BD_EMAIL, password: BD_PASSWORD, displayName: 'BD Suite Tester', role: 'business_development' });
        expect(res.status).toBe(201);
        expect(res.body.admin.role).toBe('business_development');
        expect(JSON.stringify(res.body)).not.toMatch(/password_hash/);
        bdId = res.body.admin.id;
        createdAdminIds.push(bdId);
    });

    it('returns 409 for a duplicate email', async () => {
        const res = await request(app)
            .post('/admin/admins')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ email: BD_EMAIL, password: BD_PASSWORD, displayName: 'Dupe', role: 'business_development' });
        expect(res.status).toBe(409);
    });

    it('a business_development admin gets 403 on POST /admin/admins', async () => {
        const bdLogin = await request(app)
            .post('/admin/auth/login')
            .send({ email: BD_EMAIL, password: BD_PASSWORD });
        bdToken = bdLogin.body.token;

        const res = await request(app)
            .post('/admin/admins')
            .set('Authorization', `Bearer ${bdToken}`)
            .send({ email: 'irrelevant@cirkle.live', password: 'whatever123', displayName: 'Nope', role: 'business_development' });
        expect(res.status).toBe(403);
    });

    it('lists admins without ever exposing password_hash', async () => {
        const res = await request(app)
            .get('/admin/admins')
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.admins.length).toBeGreaterThan(0);
        expect(JSON.stringify(res.body)).not.toMatch(/password_hash/);
    });

    it('deactivating an admin invalidates their existing token immediately', async () => {
        const patchRes = await request(app)
            .patch(`/admin/admins/${bdId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ isActive: false });
        expect(patchRes.status).toBe(200);
        expect(patchRes.body.admin.isActive).toBe(false);

        // The BD token was issued before deactivation — it must stop working now
        const res = await request(app)
            .get('/admin/admins')
            .set('Authorization', `Bearer ${bdToken}`);
        expect(res.status).toBe(401);

        // And they can no longer log in fresh either
        const loginRes = await request(app)
            .post('/admin/auth/login')
            .send({ email: BD_EMAIL, password: BD_PASSWORD });
        expect(loginRes.status).toBe(401);
    });

});
