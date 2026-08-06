import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import {
    validateCategoriesPayload,
    toCategoryResponse,
    buildCapacitySummary,
    findBlockedCategoryChanges
} from '../src/utils/eventCategories.js';

const app = createApp();

const ADMIN_EMAIL = 'test-admin-evcat@cirkle.live';
const ADMIN_PASSWORD = 'AdminEvCatPass123!';
const P = 'ZZEvCat ';

let adminId, adminToken, eventId;
const catalogIds = {};
const createdEventIds = [];

const createEvent = body =>
    request(app).post('/admin/events').set('Authorization', `Bearer ${adminToken}`).send(body);

const patchEvent = (id, body) =>
    request(app).patch(`/admin/events/${id}`).set('Authorization', `Bearer ${adminToken}`).send(body);

const getEvent = id =>
    request(app).get(`/admin/events/${id}`).set('Authorization', `Bearer ${adminToken}`);

const baseEvent = (overrides = {}) => ({
    name: 'EvCat Test Event',
    categoryId: 'club',
    cityId: 'del',
    startsAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    targetGroupSize: 3,
    ...overrides
});

beforeAll(async () => {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const a = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ($1, $2, 'EvCat Admin', 'administrative') RETURNING id`,
        [ADMIN_EMAIL, hash]
    );
    adminId = a.rows[0].id;
    adminToken = (await request(app).post('/admin/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).body.token;

    for (const n of ['Single', 'Couple', 'Group4', 'Retired']) {
        const r = await pool.query(
            'INSERT INTO ticket_categories (name) VALUES ($1) RETURNING id',
            [P + n]
        );
        catalogIds[n] = r.rows[0].id;
    }
    await pool.query('UPDATE ticket_categories SET is_active = false WHERE id = $1', [catalogIds.Retired]);

    const ev = await createEvent(baseEvent());
    eventId = ev.body.event.id;
    createdEventIds.push(eventId);
});

afterAll(async () => {
    await pool.query('DELETE FROM event_ticket_categories WHERE event_id = ANY($1)', [createdEventIds]);
    await pool.query('DELETE FROM audit_log WHERE entity_type = $1 AND entity_id = ANY($2)', ['event', createdEventIds]);
    await pool.query('DELETE FROM events WHERE id = ANY($1)', [createdEventIds]);
    await pool.query('DELETE FROM ticket_categories WHERE name LIKE $1', [P + '%']);
    await pool.query('DELETE FROM admins WHERE id = $1', [adminId]);
    await pool.end();
});

describe('Derivation — the unit rules', () => {

    const row = (qty, admits = 2) => ({
        id: 'r', category_id: 'c', category_name: 'X',
        price_paise: 1000, admits_count: admits, ticket_quantity: qty
    });

    it('derives peopleCapacity as admits × quantity', () => {
        expect(toCategoryResponse(row(50)).peopleCapacity).toBe(100);
    });

    it('treats null quantity as unlimited with null peopleCapacity, not zero', () => {
        const d = toCategoryResponse(row(null));
        expect(d.isUnlimited).toBe(true);
        expect(d.peopleCapacity).toBeNull();
    });

    it('keeps 0 distinct from unlimited — it means nothing to sell', () => {
        const d = toCategoryResponse(row(0));
        expect(d.isUnlimited).toBe(false);
        expect(d.peopleCapacity).toBe(0);
    });

    it('sums only finite tiers and flags unlimited separately', () => {
        const cats = [row(50, 2), row(null, 1), row(0, 4)].map(r => toCategoryResponse(r));
        expect(buildCapacitySummary(cats)).toEqual({
            totalTickets: 50, totalPeople: 100, hasUnlimited: true
        });
    });

    it('reports hasUnlimited false when every tier is finite', () => {
        const cats = [row(10, 1), row(5, 2)].map(r => toCategoryResponse(r));
        expect(buildCapacitySummary(cats)).toEqual({
            totalTickets: 15, totalPeople: 20, hasUnlimited: false
        });
    });

});

describe('Payload validation', () => {

    const ok = { categoryId: 'a', pricePaise: 1000, admitsCount: 1, ticketQuantity: 5 };

    it('accepts a valid payload and an unlimited tier', () => {
        expect(validateCategoriesPayload([ok])).toBeNull();
        expect(validateCategoriesPayload([{ ...ok, ticketQuantity: null }])).toBeNull();
        expect(validateCategoriesPayload([])).toBeNull();
    });

    it('rejects a duplicate categoryId', () => {
        expect(validateCategoriesPayload([ok, ok])).toMatch(/cannot be listed twice/);
    });

    it('rejects admitsCount below 1', () => {
        expect(validateCategoriesPayload([{ ...ok, admitsCount: 0 }])).toMatch(/admitsCount/);
    });

    it('rejects a negative price or quantity', () => {
        expect(validateCategoriesPayload([{ ...ok, pricePaise: -1 }])).toMatch(/pricePaise/);
        expect(validateCategoriesPayload([{ ...ok, ticketQuantity: -1 }])).toMatch(/ticketQuantity/);
    });

    it('rejects a non-array', () => {
        expect(validateCategoriesPayload('nope')).toMatch(/must be an array/);
    });

});

describe('The sold-tickets guard', () => {

    const existing = [{ category_id: 'c1', category_name: 'Couple' }];

    it('blocks removing a category that has sales', () => {
        expect(findBlockedCategoryChanges(existing, [], { c1: 3 })).toMatch(/Cannot remove/);
    });

    it('blocks cutting quantity below what has sold', () => {
        expect(findBlockedCategoryChanges(existing, [{ categoryId: 'c1', ticketQuantity: 2 }], { c1: 3 }))
            .toMatch(/Cannot reduce/);
    });

    it('allows going unlimited, which can only add headroom', () => {
        expect(findBlockedCategoryChanges(existing, [{ categoryId: 'c1', ticketQuantity: null }], { c1: 3 }))
            .toBeNull();
    });

    it('allows any change when nothing has sold', () => {
        expect(findBlockedCategoryChanges(existing, [], { c1: 0 })).toBeNull();
    });

});

describe('POST /admin/events — categories at create', () => {

    it('creates a draft event with no categories and no price', async () => {
        const res = await createEvent(baseEvent({ name: 'EvCat Draft' }));
        expect(res.status).toBe(201);
        createdEventIds.push(res.body.event.id);

        expect(res.body.event.categories).toEqual([]);
        expect(res.body.event.capacitySummary).toEqual({
            totalTickets: 0, totalPeople: 0, hasUnlimited: false
        });
        // price is vestigial and defaults rather than being required
        expect(res.body.event.price).toBe(0);
    });

    it('creates an event with categories and returns them derived', async () => {
        const res = await createEvent(baseEvent({
            name: 'EvCat With Categories',
            categories: [
                { categoryId: catalogIds.Couple, pricePaise: 75000, admitsCount: 2, ticketQuantity: 50 },
                { categoryId: catalogIds.Single, pricePaise: 40000, admitsCount: 1, ticketQuantity: 20 }
            ]
        }));
        expect(res.status).toBe(201);
        createdEventIds.push(res.body.event.id);

        const cats = res.body.event.categories;
        expect(cats.length).toBe(2);
        // ordered by price ascending
        expect(cats.map(c => c.categoryName)).toEqual([P + 'Single', P + 'Couple']);
        expect(cats.find(c => c.categoryName === P + 'Couple').peopleCapacity).toBe(100);
        expect(res.body.event.capacitySummary).toEqual({
            totalTickets: 70, totalPeople: 120, hasUnlimited: false
        });
    });

    it('rejects an unknown categoryId', async () => {
        const res = await createEvent(baseEvent({
            categories: [{ categoryId: '00000000-0000-0000-0000-000000000000', pricePaise: 1, admitsCount: 1, ticketQuantity: 1 }]
        }));
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/do not exist/);
    });

    it('rejects a retired categoryId', async () => {
        const res = await createEvent(baseEvent({
            categories: [{ categoryId: catalogIds.Retired, pricePaise: 1, admitsCount: 1, ticketQuantity: 1 }]
        }));
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/retired/);
    });

});

describe('PATCH /admin/events/:id — replacing categories', () => {

    it('sets categories on a previously category-less event', async () => {
        const res = await patchEvent(eventId, {
            categories: [
                { categoryId: catalogIds.Couple, pricePaise: 75000, admitsCount: 2, ticketQuantity: 50 }
            ]
        });
        expect(res.status).toBe(200);
        expect(res.body.event.categories.length).toBe(1);
        expect(res.body.event.capacitySummary.totalPeople).toBe(100);
    });

    it('accepts a PATCH carrying only categories', async () => {
        const res = await patchEvent(eventId, {
            categories: [
                { categoryId: catalogIds.Couple, pricePaise: 80000, admitsCount: 2, ticketQuantity: 40 },
                { categoryId: catalogIds.Group4, pricePaise: 150000, admitsCount: 4, ticketQuantity: 10 }
            ]
        });
        expect(res.status).toBe(200);
        expect(res.body.error).toBeUndefined();
        expect(res.body.event.categories.length).toBe(2);
        expect(res.body.event.capacitySummary).toEqual({
            totalTickets: 50, totalPeople: 120, hasUnlimited: false
        });
    });

    // The reason this is an upsert rather than delete-and-reinsert: Part 4
    // will point tickets at these rows, so their ids must survive an edit.
    it('preserves the row id of a category that stays across an edit', async () => {
        const before = await getEvent(eventId);
        const coupleBefore = before.body.event.categories.find(c => c.categoryId === catalogIds.Couple);

        await patchEvent(eventId, {
            categories: [
                { categoryId: catalogIds.Couple, pricePaise: 99000, admitsCount: 2, ticketQuantity: 30 },
                { categoryId: catalogIds.Group4, pricePaise: 150000, admitsCount: 4, ticketQuantity: 10 }
            ]
        });

        const after = await getEvent(eventId);
        const coupleAfter = after.body.event.categories.find(c => c.categoryId === catalogIds.Couple);

        expect(coupleAfter.id).toBe(coupleBefore.id);
        expect(coupleAfter.pricePaise).toBe(99000);
    });

    it('removes a category that is absent from the payload', async () => {
        const res = await patchEvent(eventId, {
            categories: [
                { categoryId: catalogIds.Couple, pricePaise: 99000, admitsCount: 2, ticketQuantity: 30 }
            ]
        });
        expect(res.status).toBe(200);
        expect(res.body.event.categories.length).toBe(1);

        const rows = await pool.query('SELECT category_id FROM event_ticket_categories WHERE event_id = $1', [eventId]);
        expect(rows.rows.length).toBe(1);
    });

    it('leaves categories untouched when the PATCH omits them', async () => {
        const res = await patchEvent(eventId, { venueName: 'Somewhere Else' });
        expect(res.status).toBe(200);
        expect(res.body.event.categories.length).toBe(1);
        expect(res.body.event.venueName).toBe('Somewhere Else');
    });

    it('clears categories when sent an empty array', async () => {
        const res = await patchEvent(eventId, { categories: [] });
        expect(res.status).toBe(200);
        expect(res.body.event.categories).toEqual([]);
        expect(res.body.event.capacitySummary.totalPeople).toBe(0);
    });

    it('still 400s on a genuinely empty body', async () => {
        const res = await patchEvent(eventId, {});
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('No fields to update');
    });

    it('rejects a duplicate categoryId with a clean 400, not a DB error', async () => {
        const res = await patchEvent(eventId, {
            categories: [
                { categoryId: catalogIds.Single, pricePaise: 1000, admitsCount: 1, ticketQuantity: 1 },
                { categoryId: catalogIds.Single, pricePaise: 2000, admitsCount: 1, ticketQuantity: 1 }
            ]
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/cannot be listed twice/);
    });

    it('lets a retired category already on the event be kept and repriced', async () => {
        // Put the retired category on directly, as if it were configured
        // before retirement.
        await pool.query(
            `INSERT INTO event_ticket_categories (event_id, category_id, price_paise, admits_count, ticket_quantity)
             VALUES ($1, $2, 5000, 1, 5)`,
            [eventId, catalogIds.Retired]
        );

        const res = await patchEvent(eventId, {
            categories: [
                { categoryId: catalogIds.Retired, pricePaise: 6000, admitsCount: 1, ticketQuantity: 5 }
            ]
        });
        expect(res.status).toBe(200);
        expect(res.body.event.categories[0].pricePaise).toBe(6000);

        await patchEvent(eventId, { categories: [] });
    });

    it('writes an audit row for a category change', async () => {
        await patchEvent(eventId, {
            categories: [{ categoryId: catalogIds.Single, pricePaise: 1000, admitsCount: 1, ticketQuantity: 3 }]
        });

        const audit = await pool.query(
            `SELECT changes FROM audit_log
             WHERE entity_type = 'event' AND entity_id = $1 AND changes ? 'categories'
             ORDER BY created_at DESC LIMIT 1`,
            [eventId]
        );
        expect(audit.rows.length).toBe(1);
        expect(audit.rows[0].changes.categories.to).toContain(catalogIds.Single);
    });

});

describe('Unlimited tiers end to end', () => {

    it('persists null quantity and reports it as unlimited', async () => {
        const res = await patchEvent(eventId, {
            categories: [
                { categoryId: catalogIds.Single, pricePaise: 40000, admitsCount: 1, ticketQuantity: null },
                { categoryId: catalogIds.Couple, pricePaise: 75000, admitsCount: 2, ticketQuantity: 10 }
            ]
        });
        expect(res.status).toBe(200);

        const unlimited = res.body.event.categories.find(c => c.categoryId === catalogIds.Single);
        expect(unlimited.ticketQuantity).toBeNull();
        expect(unlimited.isUnlimited).toBe(true);
        expect(unlimited.peopleCapacity).toBeNull();

        expect(res.body.event.capacitySummary).toEqual({
            totalTickets: 10, totalPeople: 20, hasUnlimited: true
        });

        const stored = await pool.query(
            'SELECT ticket_quantity FROM event_ticket_categories WHERE event_id = $1 AND category_id = $2',
            [eventId, catalogIds.Single]
        );
        expect(stored.rows[0].ticket_quantity).toBeNull();
    });

    it('treats an omitted ticketQuantity as unlimited', async () => {
        const res = await patchEvent(eventId, {
            categories: [{ categoryId: catalogIds.Couple, pricePaise: 75000, admitsCount: 2 }]
        });
        expect(res.status).toBe(200);
        expect(res.body.event.categories[0].isUnlimited).toBe(true);
    });

    it('the DB still rejects a negative quantity', async () => {
        await expect(pool.query(
            `INSERT INTO event_ticket_categories (event_id, category_id, price_paise, admits_count, ticket_quantity)
             VALUES ($1, $2, 100, 1, -5)`,
            [eventId, catalogIds.Group4]
        )).rejects.toThrow();
    });

});

describe('GET /admin/events/:id returns categories and the summary', () => {

    it('includes both, derived', async () => {
        await patchEvent(eventId, {
            categories: [
                { categoryId: catalogIds.Couple, pricePaise: 75000, admitsCount: 2, ticketQuantity: 50 }
            ]
        });

        const res = await getEvent(eventId);
        expect(res.status).toBe(200);

        const cat = res.body.event.categories[0];
        expect(Object.keys(cat).sort()).toEqual([
            'admitsCount', 'categoryId', 'categoryName', 'id', 'isUnlimited',
            'peopleCapacity', 'pricePaise', 'ticketQuantity', 'ticketsSold'
        ]);
        expect(cat.ticketsSold).toBe(0);
        expect(res.body.event.capacitySummary.totalPeople).toBe(100);
    });

});
