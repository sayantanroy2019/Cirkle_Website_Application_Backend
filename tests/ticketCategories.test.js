import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

const app = createApp();

const ADMIN_EMAIL = 'test-admin-ticketcat@cirkle.live';
const ADMIN_PASSWORD = 'AdminTicketCatPass123!';
const BD_EMAIL = 'test-bd-ticketcat@cirkle.live';
const BD_PASSWORD = 'BdTicketCatPass123!';

// Prefixed so cleanup can find them without touching real catalogue rows.
const P = 'ZZTest ';

let adminId, bdId, adminToken, bdToken, eventId, organizerId;
const createdCategoryIds = [];

const create = (name, token = adminToken) =>
    request(app).post('/admin/ticket-categories').set('Authorization', `Bearer ${token}`).send({ name });

const patch = (id, body, token = adminToken) =>
    request(app).patch(`/admin/ticket-categories/${id}`).set('Authorization', `Bearer ${token}`).send(body);

const list = (query = '', token = adminToken) =>
    request(app).get(`/admin/ticket-categories${query}`).set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const a = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ($1, $2, 'TicketCat Admin', 'administrative') RETURNING id`,
        [ADMIN_EMAIL, adminHash]
    );
    adminId = a.rows[0].id;

    const bdHash = await bcrypt.hash(BD_PASSWORD, 10);
    const b = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ($1, $2, 'TicketCat BD', 'business_development') RETURNING id`,
        [BD_EMAIL, bdHash]
    );
    bdId = b.rows[0].id;

    adminToken = (await request(app).post('/admin/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).body.token;
    bdToken = (await request(app).post('/admin/auth/login').send({ email: BD_EMAIL, password: BD_PASSWORD })).body.token;

    const org = await pool.query(
        `INSERT INTO organizers (email, password_hash, display_name)
         VALUES ('test-org-ticketcat@cirkle.live', 'x', 'TicketCat Org') RETURNING id`
    );
    organizerId = org.rows[0].id;

    const ev = await pool.query(
        `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size, organizer_id)
         VALUES ('TicketCat Test Event', 'club', 'del', now() + interval '20 days', 50000, 3, $1)
         RETURNING id`,
        [organizerId]
    );
    eventId = ev.rows[0].id;
});

afterAll(async () => {
    await pool.query('DELETE FROM event_ticket_categories WHERE event_id = $1', [eventId]);
    await pool.query('DELETE FROM audit_log WHERE entity_type = $1', ['ticket_category']);
    await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
    await pool.query('DELETE FROM organizers WHERE id = $1', [organizerId]);
    await pool.query('DELETE FROM ticket_categories WHERE name LIKE $1', [P + '%']);
    await pool.query('DELETE FROM admins WHERE id = ANY($1)', [[adminId, bdId]]);
    await pool.end();
});

describe('Schema — constraints are live', () => {

    it('event_ticket_categories enforces its CHECKs and UNIQUE', async () => {
        const cat = await create(P + 'Constraint Check');
        createdCategoryIds.push(cat.body.ticketCategory.id);
        const categoryId = cat.body.ticketCategory.id;

        const insert = (price, admits, qty) => pool.query(
            `INSERT INTO event_ticket_categories (event_id, category_id, price_paise, admits_count, ticket_quantity)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [eventId, categoryId, price, admits, qty]
        );

        await expect(insert(300000, 0, 10)).rejects.toThrow();    // admits_count >= 1
        await expect(insert(300000, 2, -1)).rejects.toThrow();    // ticket_quantity >= 0
        await expect(insert(-1, 2, 10)).rejects.toThrow();        // price_paise >= 0

        const ok = await insert(300000, 2, 50);
        expect(ok.rows.length).toBe(1);

        // An event lists each catalogue category at most once.
        await expect(insert(400000, 2, 10)).rejects.toThrow();

        // ticket_quantity of 0 is legal — a sold-out or not-yet-stocked tier.
        const other = await create(P + 'Zero Stock');
        createdCategoryIds.push(other.body.ticketCategory.id);
        const zero = await pool.query(
            `INSERT INTO event_ticket_categories (event_id, category_id, price_paise, admits_count, ticket_quantity)
             VALUES ($1, $2, 0, 1, 0) RETURNING id`,
            [eventId, other.body.ticketCategory.id]
        );
        expect(zero.rows.length).toBe(1);

        await pool.query('DELETE FROM event_ticket_categories WHERE event_id = $1', [eventId]);
    });

    it('a catalogue category in use cannot be hard-deleted', async () => {
        const cat = await create(P + 'In Use');
        const categoryId = cat.body.ticketCategory.id;
        createdCategoryIds.push(categoryId);

        await pool.query(
            `INSERT INTO event_ticket_categories (event_id, category_id, price_paise, admits_count, ticket_quantity)
             VALUES ($1, $2, 100000, 1, 5)`,
            [eventId, categoryId]
        );

        // No cascade on category_id — this is what forces retirement instead.
        await expect(
            pool.query('DELETE FROM ticket_categories WHERE id = $1', [categoryId])
        ).rejects.toThrow();

        await pool.query('DELETE FROM event_ticket_categories WHERE event_id = $1', [eventId]);
    });

    it('deleting an event removes its category rows', async () => {
        const cat = await create(P + 'Cascade');
        createdCategoryIds.push(cat.body.ticketCategory.id);

        const tmpEvent = await pool.query(
            `INSERT INTO events (name, category_id, city_id, starts_at, price, target_group_size)
             VALUES ('TicketCat Cascade Event', 'club', 'del', now() + interval '5 days', 1000, 2)
             RETURNING id`
        );
        await pool.query(
            `INSERT INTO event_ticket_categories (event_id, category_id, price_paise, admits_count, ticket_quantity)
             VALUES ($1, $2, 100000, 1, 5)`,
            [tmpEvent.rows[0].id, cat.body.ticketCategory.id]
        );

        await pool.query('DELETE FROM events WHERE id = $1', [tmpEvent.rows[0].id]);

        const left = await pool.query('SELECT id FROM event_ticket_categories WHERE event_id = $1', [tmpEvent.rows[0].id]);
        expect(left.rows.length).toBe(0);
        // The catalogue name survives — only the per-event config went.
        const stillThere = await pool.query('SELECT id FROM ticket_categories WHERE id = $1', [cat.body.ticketCategory.id]);
        expect(stillThere.rows.length).toBe(1);
    });

});

describe('POST /admin/ticket-categories', () => {

    it('creates a category and writes an audit row', async () => {
        const res = await create(P + 'Single Pass');
        expect(res.status).toBe(201);
        expect(res.body.ticketCategory.name).toBe(P + 'Single Pass');
        expect(res.body.ticketCategory.isActive).toBe(true);
        createdCategoryIds.push(res.body.ticketCategory.id);

        const audit = await pool.query(
            `SELECT action, changes FROM audit_log
             WHERE entity_type = 'ticket_category' AND entity_id = $1`,
            [res.body.ticketCategory.id]
        );
        expect(audit.rows.length).toBe(1);
        expect(audit.rows[0].action).toBe('create');
        expect(audit.rows[0].changes.name).toBe(P + 'Single Pass');
    });

    it('trims and collapses whitespace in the name', async () => {
        const res = await create('   ' + P + 'Couple    Pass   ');
        expect(res.status).toBe(201);
        expect(res.body.ticketCategory.name).toBe(P + 'Couple Pass');
        createdCategoryIds.push(res.body.ticketCategory.id);
    });

    it('rejects a duplicate name case-insensitively', async () => {
        const first = await create(P + 'VIP');
        expect(first.status).toBe(201);
        createdCategoryIds.push(first.body.ticketCategory.id);

        const exact = await create(P + 'VIP');
        expect(exact.status).toBe(409);

        const differentCase = await create((P + 'vip').toLowerCase());
        expect(differentCase.status).toBe(409);
    });

    it('rejects a missing or blank name', async () => {
        expect((await create(undefined)).status).toBe(400);
        expect((await create('    ')).status).toBe(400);
    });

    it('requires an admin token', async () => {
        const res = await request(app).post('/admin/ticket-categories').send({ name: P + 'NoAuth' });
        expect(res.status).toBe(401);
    });

});

describe('PATCH /admin/ticket-categories/:id', () => {

    let id;

    beforeAll(async () => {
        const res = await create(P + 'Renameable');
        id = res.body.ticketCategory.id;
        createdCategoryIds.push(id);
    });

    it('renames and records a from/to diff', async () => {
        const res = await patch(id, { name: P + 'Renamed' });
        expect(res.status).toBe(200);
        expect(res.body.ticketCategory.name).toBe(P + 'Renamed');

        const audit = await pool.query(
            `SELECT changes FROM audit_log
             WHERE entity_type = 'ticket_category' AND entity_id = $1 AND action = 'update'
             ORDER BY created_at DESC LIMIT 1`,
            [id]
        );
        expect(audit.rows[0].changes.name).toEqual({ from: P + 'Renameable', to: P + 'Renamed' });
    });

    it('409s when renaming onto an existing name, case-insensitively', async () => {
        const other = await create(P + 'Occupied');
        createdCategoryIds.push(other.body.ticketCategory.id);

        expect((await patch(id, { name: P + 'Occupied' })).status).toBe(409);
        expect((await patch(id, { name: (P + 'OCCUPIED').toUpperCase() })).status).toBe(409);
    });

    it('400s on an empty body', async () => {
        const res = await patch(id, {});
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('No fields to update');
    });

    it('400s on a non-boolean isActive and on a blank name', async () => {
        expect((await patch(id, { isActive: 'yes' })).status).toBe(400);
        expect((await patch(id, { name: '   ' })).status).toBe(400);
    });

    it('404s for an unknown id', async () => {
        const res = await patch('00000000-0000-0000-0000-000000000000', { isActive: false });
        expect(res.status).toBe(404);
    });

    it('toggles isActive and audits it', async () => {
        const res = await patch(id, { isActive: false });
        expect(res.status).toBe(200);
        expect(res.body.ticketCategory.isActive).toBe(false);

        const audit = await pool.query(
            `SELECT changes FROM audit_log
             WHERE entity_type = 'ticket_category' AND entity_id = $1 AND changes ? 'is_active'
             ORDER BY created_at DESC LIMIT 1`,
            [id]
        );
        expect(audit.rows[0].changes.is_active).toEqual({ from: true, to: false });

        await patch(id, { isActive: true });
    });

});

describe('Retirement', () => {

    it('drops a retired name from the active list but keeps the row and its references', async () => {
        const cat = await create(P + 'Retiring');
        const categoryId = cat.body.ticketCategory.id;
        createdCategoryIds.push(categoryId);

        // An event references it before retirement.
        await pool.query(
            `INSERT INTO event_ticket_categories (event_id, category_id, price_paise, admits_count, ticket_quantity)
             VALUES ($1, $2, 250000, 2, 20)`,
            [eventId, categoryId]
        );

        const before = await list('?isActive=true');
        expect(before.body.ticketCategories.some(c => c.id === categoryId)).toBe(true);

        await patch(categoryId, { isActive: false });

        // Gone from the dropdown set...
        const active = await list('?isActive=true');
        expect(active.body.ticketCategories.some(c => c.id === categoryId)).toBe(false);

        // ...present in the retired set, and still resolvable...
        const inactive = await list('?isActive=false');
        expect(inactive.body.ticketCategories.some(c => c.id === categoryId)).toBe(true);

        // ...and the event's reference is untouched.
        const ref = await pool.query(
            'SELECT price_paise, admits_count, ticket_quantity FROM event_ticket_categories WHERE event_id = $1 AND category_id = $2',
            [eventId, categoryId]
        );
        expect(ref.rows.length).toBe(1);
        expect(ref.rows[0]).toEqual({ price_paise: 250000, admits_count: 2, ticket_quantity: 20 });

        await pool.query('DELETE FROM event_ticket_categories WHERE event_id = $1', [eventId]);
    });

    it('exposes no DELETE route', async () => {
        const cat = await create(P + 'Undeletable');
        createdCategoryIds.push(cat.body.ticketCategory.id);

        const res = await request(app)
            .delete(`/admin/ticket-categories/${cat.body.ticketCategory.id}`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(404);

        const stillThere = await pool.query('SELECT id FROM ticket_categories WHERE id = $1', [cat.body.ticketCategory.id]);
        expect(stillThere.rows.length).toBe(1);
    });

});

describe('GET /admin/ticket-categories', () => {

    it('lists the catalogue sorted by name', async () => {
        const res = await list();
        expect(res.status).toBe(200);
        const ours = res.body.ticketCategories.filter(c => c.name.startsWith(P)).map(c => c.name);
        expect(ours).toEqual([...ours].sort());
    });

    it('returns the documented shape', async () => {
        const res = await list();
        expect(Object.keys(res.body.ticketCategories[0]).sort())
            .toEqual(['createdAt', 'id', 'isActive', 'name']);
    });

    it('rejects a non-boolean isActive filter', async () => {
        const res = await list('?isActive=maybe');
        expect(res.status).toBe(400);
    });

});

describe('Both admin roles may manage the catalogue', () => {

    it('a business_development admin can create, list and patch', async () => {
        const created = await create(P + 'BD Made This', bdToken);
        expect(created.status).toBe(201);
        createdCategoryIds.push(created.body.ticketCategory.id);

        expect((await list('', bdToken)).status).toBe(200);

        const patched = await patch(created.body.ticketCategory.id, { isActive: false }, bdToken);
        expect(patched.status).toBe(200);
    });

});
