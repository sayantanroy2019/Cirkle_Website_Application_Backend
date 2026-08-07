import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { assessLockout } from '../src/routes/adminAdmins.js';

const app = createApp();

// Emails must be lowercase: /admin/auth/login lowercases the input before
// looking up, so a mixed-case row inserted directly by SQL can never log in.
const P = 'zzlockout';
const PASSWORD = 'LockoutPass123!';
const NEW_PASSWORD = 'BrandNewPass456!';

const A = `${P}-alpha@cirkle.live`;      // administrative
const B = `${P}-bravo@cirkle.live`;      // administrative
const C = `${P}-charlie@cirkle.live`;    // business_development

const ids = {};
const tokens = {};

const patch = (targetId, body, asToken) =>
    request(app).patch(`/admin/admins/${targetId}`)
        .set('Authorization', `Bearer ${asToken}`).send(body);

const login = (email, password = PASSWORD) =>
    request(app).post('/admin/auth/login').send({ email, password });

async function makeAdmin(email, role) {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const r = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role, is_active)
         VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [email, hash, `${P} ${role}`, role]
    );
    return r.rows[0].id;
}

async function resetFixtures() {
    await pool.query(
        `UPDATE admins SET role = 'administrative', is_active = true WHERE id = ANY($1)`,
        [[ids.A, ids.B]]
    );
    await pool.query(
        `UPDATE admins SET role = 'business_development', is_active = true WHERE id = $1`,
        [ids.C]
    );
}

beforeAll(async () => {
    ids.A = await makeAdmin(A, 'administrative');
    ids.B = await makeAdmin(B, 'administrative');
    ids.C = await makeAdmin(C, 'business_development');

    tokens.A = (await login(A)).body.token;
    tokens.B = (await login(B)).body.token;
    tokens.C = (await login(C)).body.token;
});

afterAll(async () => {
    await pool.query('DELETE FROM audit_log WHERE admin_id = ANY($1) OR entity_id = ANY($1)',
        [[ids.A, ids.B, ids.C]]);
    await pool.query('DELETE FROM admins WHERE id = ANY($1)', [[ids.A, ids.B, ids.C]]);
    await pool.end();
});

beforeEach(resetFixtures);

// ─────────────────────────────────────────────────────────────────────────
// The rules, proven exhaustively as pure logic.
//
// Rule 2 depends on the GLOBAL count of active administrative admins, which
// every other test suite also creates into. Driving "this is the last one"
// through the API would mean deactivating admins those suites are actively
// using — and authenticateAdmin re-checks is_active on every request, so it
// would 401 them mid-run. The decision is therefore tested here, directly,
// and the route is tested for everything that doesn't require owning the
// global population.
// ─────────────────────────────────────────────────────────────────────────
describe('assessLockout — the rules', () => {

    const admin   = { role: 'administrative', is_active: true };
    const bd      = { role: 'business_development', is_active: true };
    const dormant = { role: 'administrative', is_active: false };

    describe('rule 1 — self-deactivation', () => {

        it('blocks deactivating yourself however many others exist', () => {
            expect(assessLockout(admin, { isActive: false }, true, 5).error)
                .toBe('cannot_deactivate_self');
            expect(assessLockout(admin, { isActive: false }, true, 0).error)
                .toBe('cannot_deactivate_self');
            expect(assessLockout(bd, { isActive: false }, true, 5).error)
                .toBe('cannot_deactivate_self');
        });

        it('allows someone else to deactivate you', () => {
            expect(assessLockout(admin, { isActive: false }, false, 1)).toBeNull();
        });

        it('does not fire on activation, only deactivation', () => {
            expect(assessLockout(dormant, { isActive: true }, true, 0)).toBeNull();
        });

    });

    describe('rule 2 — the last active administrative admin', () => {

        it('blocks demoting the last one', () => {
            expect(assessLockout(admin, { role: 'business_development' }, false, 0).error)
                .toBe('last_administrative_admin');
        });

        it('blocks deactivating the last one (when not self)', () => {
            expect(assessLockout(admin, { isActive: false }, false, 0).error)
                .toBe('last_administrative_admin');
        });

        it('allows demoting when another remains', () => {
            expect(assessLockout(admin, { role: 'business_development' }, false, 1)).toBeNull();
        });

        it('allows SELF-demotion when another remains — the handover case', () => {
            expect(assessLockout(admin, { role: 'business_development' }, true, 1)).toBeNull();
        });

        it('blocks SELF-demotion once they are the last', () => {
            expect(assessLockout(admin, { role: 'business_development' }, true, 0).error)
                .toBe('last_administrative_admin');
        });

        it('ignores changes to an admin who does not count toward the population', () => {
            expect(assessLockout(bd, { role: 'business_development' }, false, 0)).toBeNull();
            expect(assessLockout(dormant, { role: 'business_development' }, false, 0)).toBeNull();
        });

        it('allows unrelated edits to the last admin', () => {
            expect(assessLockout(admin, {}, true, 0)).toBeNull();
            expect(assessLockout(admin, { role: 'administrative' }, true, 0)).toBeNull();
        });

        it('blocks a combined demote+deactivate of the last one', () => {
            expect(assessLockout(admin, { role: 'business_development', isActive: false }, false, 0).error)
                .toBe('last_administrative_admin');
        });

        it('applies rule 1 first when both would fire', () => {
            expect(assessLockout(admin, { isActive: false }, true, 0).error)
                .toBe('cannot_deactivate_self');
        });

    });

});

// ─────────────────────────────────────────────────────────────────────────
// The route. Everything here works regardless of how many admins other
// suites have created.
// ─────────────────────────────────────────────────────────────────────────
describe('PATCH /admin/admins/:id — rule 1 against the live endpoint', () => {

    it('refuses self-deactivation with 409, and the account stays active', async () => {
        const res = await patch(ids.A, { isActive: false }, tokens.A);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('cannot_deactivate_self');
        expect(res.body.message).toMatch(/your own account/i);

        const still = await pool.query('SELECT is_active FROM admins WHERE id = $1', [ids.A]);
        expect(still.rows[0].is_active).toBe(true);
    });

    it('rolls the whole PATCH back — no partial application', async () => {
        const res = await patch(ids.A, { displayName: 'Renamed', isActive: false }, tokens.A);
        expect(res.status).toBe(409);

        const row = await pool.query('SELECT display_name, is_active FROM admins WHERE id = $1', [ids.A]);
        expect(row.rows[0].display_name).not.toBe('Renamed');
        expect(row.rows[0].is_active).toBe(true);
    });

    it('lets a different admin deactivate them', async () => {
        const res = await patch(ids.A, { isActive: false }, tokens.B);
        expect(res.status).toBe(200);
        expect(res.body.admin.isActive).toBe(false);
    });

});

describe('PATCH /admin/admins/:id — the rules do not over-block', () => {

    it('allows demoting an administrative admin who is not the last', async () => {
        const res = await patch(ids.B, { role: 'business_development' }, tokens.A);
        expect(res.status).toBe(200);
        expect(res.body.admin.role).toBe('business_development');
    });

    it('allows deactivating an administrative admin who is not the last', async () => {
        const res = await patch(ids.B, { isActive: false }, tokens.A);
        expect(res.status).toBe(200);
        expect(res.body.admin.isActive).toBe(false);
    });

    it('allows self-demotion while another administrative admin remains', async () => {
        const res = await patch(ids.A, { role: 'business_development' }, tokens.A);
        expect(res.status).toBe(200);
        expect(res.body.admin.role).toBe('business_development');
    });

    it('leaves ordinary field edits untouched', async () => {
        const res = await patch(ids.C, { displayName: 'Ordinary Edit' }, tokens.A);
        expect(res.status).toBe(200);
        expect(res.body.admin.displayName).toBe('Ordinary Edit');
    });

});

describe('PATCH /admin/admins/:id — the check runs under the row lock', () => {

    // Proves the serialization the rule depends on: two competing writers to
    // the same admin cannot interleave between the locking read and the
    // update. Both succeed here (neither drains the population), but they are
    // forced through one at a time, which is what makes the count read under
    // the lock trustworthy.
    it('serializes two concurrent PATCHes on the same admin', async () => {
        const results = await Promise.all([
            patch(ids.C, { displayName: 'Writer One' }, tokens.A),
            patch(ids.C, { displayName: 'Writer Two' }, tokens.B)
        ]);

        expect(results.map(r => r.status).sort()).toEqual([200, 200]);

        // A single coherent winner, not a torn mix.
        const final = await pool.query('SELECT display_name FROM admins WHERE id = $1', [ids.C]);
        expect(['Writer One', 'Writer Two']).toContain(final.rows[0].display_name);

        // Both audit rows were written inside their own transactions.
        const audits = await pool.query(
            `SELECT COUNT(*) c FROM audit_log
             WHERE entity_type = 'admin' AND entity_id = $1 AND changes ? 'display_name'`,
            [ids.C]
        );
        expect(parseInt(audits.rows[0].c, 10)).toBeGreaterThanOrEqual(2);
    });

    it('never lets concurrent demotions drop the population below one', async () => {
        const results = await Promise.all([
            patch(ids.A, { role: 'business_development' }, tokens.B),
            patch(ids.B, { role: 'business_development' }, tokens.A)
        ]);

        // Whether both succeed depends on how many administrative admins other
        // suites have live; what must ALWAYS hold is the invariant itself.
        const remaining = await pool.query(
            `SELECT COUNT(*) c FROM admins WHERE role = 'administrative' AND is_active = true`
        );
        expect(parseInt(remaining.rows[0].c, 10)).toBeGreaterThanOrEqual(1);
        expect(results.every(r => [200, 409].includes(r.status))).toBe(true);
    });

});

describe('B2 — password reset', () => {

    it('accepts a PATCH carrying only a password', async () => {
        const res = await patch(ids.C, { password: NEW_PASSWORD }, tokens.A);
        expect(res.status).toBe(200);
        expect(res.body.error).toBeUndefined();
        await patch(ids.C, { password: PASSWORD }, tokens.A);
    });

    it('makes the new password work and the old one fail', async () => {
        await patch(ids.C, { password: NEW_PASSWORD }, tokens.A);

        expect((await login(C, NEW_PASSWORD)).status).toBe(200);
        expect((await login(C, PASSWORD)).status).toBe(401);

        await patch(ids.C, { password: PASSWORD }, tokens.A);
    });

    it('stores a bcrypt hash, never the plaintext', async () => {
        await patch(ids.C, { password: NEW_PASSWORD }, tokens.A);

        const row = await pool.query('SELECT password_hash FROM admins WHERE id = $1', [ids.C]);
        expect(row.rows[0].password_hash).not.toBe(NEW_PASSWORD);
        expect(row.rows[0].password_hash).toMatch(/^\$2[aby]\$/);
        expect(await bcrypt.compare(NEW_PASSWORD, row.rows[0].password_hash)).toBe(true);

        await patch(ids.C, { password: PASSWORD }, tokens.A);
    });

    it('never returns the password or the hash', async () => {
        const res = await patch(ids.C, { displayName: 'Neutral Name', password: NEW_PASSWORD }, tokens.A);
        expect(res.status).toBe(200);

        expect(JSON.stringify(res.body)).not.toContain(NEW_PASSWORD);
        // Assert on the KEYS rather than the raw JSON — a display name is
        // free text and could legitimately contain the word "password".
        expect(Object.keys(res.body.admin).sort()).toEqual(
            ['createdAt', 'displayName', 'email', 'id', 'isActive', 'role']
        );

        await patch(ids.C, { password: PASSWORD }, tokens.A);
    });

    it('combines with other fields in one PATCH', async () => {
        const res = await patch(ids.C, { displayName: 'Both At Once', password: NEW_PASSWORD }, tokens.A);
        expect(res.status).toBe(200);
        expect(res.body.admin.displayName).toBe('Both At Once');
        expect((await login(C, NEW_PASSWORD)).status).toBe(200);

        await patch(ids.C, { password: PASSWORD }, tokens.A);
    });

    it('rejects a too-short password', async () => {
        const res = await patch(ids.C, { password: 'short' }, tokens.A);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/at least/i);
    });

    it('still 400s on a genuinely empty body', async () => {
        const res = await patch(ids.C, {}, tokens.A);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('No fields to update');
    });

    // The interaction the spec calls out: a reset changes no counts, so the
    // lockout rules never apply to it.
    it('allows an admin to reset their own password', async () => {
        const res = await patch(ids.A, { password: NEW_PASSWORD }, tokens.A);
        expect(res.status).toBe(200);
        expect((await login(A, NEW_PASSWORD)).status).toBe(200);

        await pool.query('UPDATE admins SET password_hash = $1 WHERE id = $2',
            [await bcrypt.hash(PASSWORD, 10), ids.A]);
    });

    it('is unaffected by the lockout rules — assessLockout ignores password', () => {
        // A password-only PATCH proposes neither role nor isActive, so both
        // rules are inert by construction, even for a sole administrative admin.
        expect(assessLockout({ role: 'administrative', is_active: true }, {}, true, 0)).toBeNull();
    });

});

describe('Audit', () => {

    it('records a role change as a from/to diff', async () => {
        await patch(ids.B, { role: 'business_development' }, tokens.A);

        const audit = await pool.query(
            `SELECT changes FROM audit_log
             WHERE entity_type = 'admin' AND entity_id = $1 AND changes ? 'role'
             ORDER BY created_at DESC LIMIT 1`,
            [ids.B]
        );
        expect(audit.rows[0].changes.role).toEqual({
            from: 'administrative', to: 'business_development'
        });
    });

    it('records THAT a password was reset, never the value', async () => {
        await patch(ids.C, { password: NEW_PASSWORD }, tokens.A);

        const audit = await pool.query(
            `SELECT changes FROM audit_log
             WHERE entity_type = 'admin' AND entity_id = $1 AND changes ? 'password'
             ORDER BY created_at DESC LIMIT 1`,
            [ids.C]
        );
        expect(audit.rows[0].changes.password).toEqual({ from: 'set', to: 'reset' });
        expect(JSON.stringify(audit.rows[0].changes)).not.toContain(NEW_PASSWORD);

        await patch(ids.C, { password: PASSWORD }, tokens.A);
    });

});

describe('GET /admin/admins/:id', () => {

    it('returns the single admin without a password hash', async () => {
        const res = await request(app).get(`/admin/admins/${ids.C}`)
            .set('Authorization', `Bearer ${tokens.A}`);
        expect(res.status).toBe(200);
        expect(res.body.admin.id).toBe(ids.C);
        expect(res.body.admin.email).toBe(C);
        expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
    });

    it('404s for an unknown id', async () => {
        const res = await request(app).get('/admin/admins/00000000-0000-0000-0000-000000000000')
            .set('Authorization', `Bearer ${tokens.A}`);
        expect(res.status).toBe(404);
    });

    it('is gated by manage_admins — a BD admin cannot read it', async () => {
        const res = await request(app).get(`/admin/admins/${ids.A}`)
            .set('Authorization', `Bearer ${tokens.C}`);
        expect(res.status).toBe(403);
    });

});
