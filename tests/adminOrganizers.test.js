import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

const app = createApp();

const ADMIN_EMAIL = 'test-admin-orgs@cirkle.live';
const ADMIN_PASSWORD = 'AdminOrgsPass123!';
const ORG_EMAIL = 'test-org-suite@cirkle.live';
const ORG_PASSWORD = 'OrgSuitePass123!';
const ORG_NEW_PASSWORD = 'OrgSuiteNewPass456!';

let adminId, adminToken;
const createdOrganizerIds = [];

beforeAll(async () => {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const inserted = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ($1, $2, 'Test Orgs Admin', 'administrative')
         RETURNING id`,
        [ADMIN_EMAIL, passwordHash]
    );
    adminId = inserted.rows[0].id;

    const loginRes = await request(app)
        .post('/admin/auth/login')
        .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    adminToken = loginRes.body.token;
}, 30000);

afterAll(async () => {
    await pool.query('DELETE FROM audit_log WHERE entity_type = $1 AND entity_id = ANY($2)', ['organizer', createdOrganizerIds]);
    await pool.query('DELETE FROM organizers WHERE id = ANY($1)', [createdOrganizerIds]);
    await pool.query('DELETE FROM admins WHERE id = $1', [adminId]);
    await pool.end();
});

describe('POST /admin/organizers', () => {

    it('creates an organizer, never returns password_hash, and writes an audit row', async () => {
        const res = await request(app)
            .post('/admin/organizers')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ email: ORG_EMAIL, password: ORG_PASSWORD, displayName: 'Test Organizer' });

        expect(res.status).toBe(201);
        expect(res.body.organizer.email).toBe(ORG_EMAIL);
        expect(JSON.stringify(res.body)).not.toMatch(/password_hash|password/i);

        createdOrganizerIds.push(res.body.organizer.id);

        const auditRes = await pool.query(
            `SELECT action, entity_type, entity_id, changes, admin_id
             FROM audit_log WHERE entity_type = 'organizer' AND entity_id = $1`,
            [res.body.organizer.id]
        );
        expect(auditRes.rows.length).toBe(1);
        expect(auditRes.rows[0].action).toBe('create');
        expect(auditRes.rows[0].admin_id).toBe(adminId);
        // The audit row itself must never contain the raw password
        expect(JSON.stringify(auditRes.rows[0].changes)).not.toMatch(new RegExp(ORG_PASSWORD));
        expect(JSON.stringify(auditRes.rows[0].changes)).not.toMatch(/password_hash/);
    });

    it('returns 409 for a duplicate email', async () => {
        const res = await request(app)
            .post('/admin/organizers')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ email: ORG_EMAIL, password: ORG_PASSWORD, displayName: 'Dupe' });
        expect(res.status).toBe(409);
    });

    it('returns 400 for a short password', async () => {
        const res = await request(app)
            .post('/admin/organizers')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ email: 'shortpw@cirkle.live', password: 'short', displayName: 'X' });
        expect(res.status).toBe(400);
    });

});

describe('GET /admin/organizers', () => {

    it('lists organizers with an event count, never password_hash', async () => {
        const res = await request(app)
            .get('/admin/organizers')
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.organizers.length).toBeGreaterThan(0);
        expect(res.body.organizers[0].eventCount).toBeDefined();
        expect(JSON.stringify(res.body)).not.toMatch(/password_hash/);
    });

    it('returns 404 for a nonexistent organizer', async () => {
        const res = await request(app)
            .get('/admin/organizers/00000000-0000-0000-0000-000000000000')
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(404);
    });

});

describe('PATCH /admin/organizers/:id', () => {
    let orgId;

    beforeAll(async () => {
        const res = await request(app)
            .post('/admin/organizers')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ email: 'test-org-patch@cirkle.live', password: ORG_PASSWORD, displayName: 'Patch Target' });
        orgId = res.body.organizer.id;
        createdOrganizerIds.push(orgId);
    });

    it('updates displayName and records a from/to audit diff', async () => {
        const res = await request(app)
            .patch(`/admin/organizers/${orgId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ displayName: 'Renamed Organizer' });

        expect(res.status).toBe(200);
        expect(res.body.organizer.displayName).toBe('Renamed Organizer');

        const auditRes = await pool.query(
            `SELECT changes FROM audit_log
             WHERE entity_type = 'organizer' AND entity_id = $1 AND action = 'update'
             ORDER BY created_at DESC LIMIT 1`,
            [orgId]
        );
        expect(auditRes.rows[0].changes.display_name.from).toBe('Patch Target');
        expect(auditRes.rows[0].changes.display_name.to).toBe('Renamed Organizer');
    });

    it('resets the password — old password stops working, new one works', async () => {
        const patchRes = await request(app)
            .patch(`/admin/organizers/${orgId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ password: ORG_NEW_PASSWORD });
        expect(patchRes.status).toBe(200);
        expect(JSON.stringify(patchRes.body)).not.toMatch(/password_hash/);

        // Audit records that a password was set, never the value
        const auditRes = await pool.query(
            `SELECT changes FROM audit_log
             WHERE entity_type = 'organizer' AND entity_id = $1 AND action = 'update'
             ORDER BY created_at DESC LIMIT 1`,
            [orgId]
        );
        expect(JSON.stringify(auditRes.rows[0].changes)).not.toMatch(new RegExp(ORG_NEW_PASSWORD));
        expect(auditRes.rows[0].changes.password).toEqual({ from: 'set', to: 'reset' });

        // Confirm against the DB directly that the hash actually changed and validates
        const dbRow = await pool.query('SELECT password_hash FROM organizers WHERE id = $1', [orgId]);
        const valid = await bcrypt.compare(ORG_NEW_PASSWORD, dbRow.rows[0].password_hash);
        expect(valid).toBe(true);
        const oldStillValid = await bcrypt.compare(ORG_PASSWORD, dbRow.rows[0].password_hash);
        expect(oldStillValid).toBe(false);
    });

    it('returns 404 for a nonexistent organizer', async () => {
        const res = await request(app)
            .patch('/admin/organizers/00000000-0000-0000-0000-000000000000')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ displayName: 'Nope' });
        expect(res.status).toBe(404);
    });

});
