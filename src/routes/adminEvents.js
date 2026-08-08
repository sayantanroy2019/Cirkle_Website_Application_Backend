import express from 'express';
import { pool } from '../config/db.js';
import authenticateAdmin from '../middlewares/authenticateAdmin.js';
import { recordAudit, diffChanges } from '../utils/audit.js';
import {
    objectExists,
    getPhotoViewUrl,
    getPhotoViewUrls,
    createEventImageUploadUrl,
    createArtistPhotoUploadUrl
} from '../utils/s3.js';
import { normalizeInstagram } from '../utils/socialHandles.js';
import {
    validateCategoriesPayload,
    validateCatalogIds,
    findBlockedCategoryChanges,
    ticketsSoldByCategory,
    replaceEventCategories,
    fetchEventCategories,
    buildCapacitySummary,
    categorySummariesForEvents,
    priceRange
} from '../utils/eventCategories.js';

const adminEventsRouter = express.Router();

const ALLOWED_EVENT_TYPES = ['open', 'invite_only'];
const EDITABLE_COLUMNS = [
    'name', 'category_id', 'city_id', 'starts_at', 'ends_at',
    'target_group_size', 'event_type',
    'venue_name', 'venue_address', 'description', 'organizer_id',
    'require_facebook', 'require_instagram', 'require_linkedin'
];

const REQUIREMENT_FLAGS = ['requireFacebook', 'requireInstagram', 'requireLinkedin'];

// Both admin roles may manage events — not gated by manage_admins.
adminEventsRouter.use(authenticateAdmin);

function toResponse(row) {
    return {
        id:              row.id,
        name:            row.name,
        categoryId:      row.category_id,
        cityId:          row.city_id,
        startsAt:        row.starts_at,
        endsAt:          row.ends_at,
        // events.price and events.capacity are no longer surfaced. Price is
        // per category, and capacity is derived (see capacitySummary on the
        // detail response). The columns still exist but nothing reads them;
        // a later cleanup drops them.
        targetGroupSize: row.target_group_size,
        eventType:       row.event_type,
        venueName:       row.venue_name,
        venueAddress:    row.venue_address,
        description:     row.description,
        organizerId:     row.organizer_id,
        requireFacebook:  row.require_facebook,
        requireInstagram: row.require_instagram,
        requireLinkedin:  row.require_linkedin,
        createdAt:       row.created_at,
        updatedAt:       row.updated_at
    };
}

// Shared validation for fields that appear on both create and edit.
// `partial` = true skips presence checks (PATCH only validates what's sent).
function validateEventFields(body, { partial }) {
    const { name, startsAt, endsAt, targetGroupSize, eventType } = body;

    if (!partial || name !== undefined) {
        if (!name || !name.trim()) {
            return 'name is required';
        }
    }

    if (!partial && !startsAt) {
        return 'startsAt is required';
    }
    if (startsAt !== undefined) {
        const startsAtDate = new Date(startsAt);
        if (isNaN(startsAtDate.getTime())) {
            return 'Invalid startsAt format';
        }
        // On create, always future. On edit, only validated as future when
        // it's actually being changed — so other fields (venue, description,
        // price, ...) stay editable on events that already started.
        if (startsAtDate <= new Date()) {
            return 'startsAt must be in the future';
        }
    }

    if (endsAt !== undefined && endsAt !== null) {
        if (isNaN(new Date(endsAt).getTime())) {
            return 'Invalid endsAt format';
        }
    }

    // price and capacity are gone from the API as of Part 4. Price is per
    // category; capacity is derived from admits_count * ticket_quantity summed
    // across categories. The columns remain in the table but are no longer
    // read, written meaningfully, or accepted — a later cleanup drops them.
    // Anything still sending them is ignored rather than rejected, so an
    // un-updated client doesn't break.

    if (!partial && (targetGroupSize === undefined || targetGroupSize === null)) {
        return 'targetGroupSize is required';
    }
    if (targetGroupSize !== undefined && (!Number.isInteger(targetGroupSize) || targetGroupSize <= 0)) {
        return 'targetGroupSize must be a positive integer';
    }

    if (eventType !== undefined && !ALLOWED_EVENT_TYPES.includes(eventType)) {
        return `eventType must be one of: ${ALLOWED_EVENT_TYPES.join(', ')}`;
    }

    for (const flag of REQUIREMENT_FLAGS) {
        if (body[flag] !== undefined && typeof body[flag] !== 'boolean') {
            return `${flag} must be a boolean`;
        }
    }

    return null;
}

// POST /admin/events
// Creates an event with no images — a new event needs an id before images
// can be keyed to events/{eventId}/..., so images are attached afterward
// via the endpoints below.
adminEventsRouter.post('/', async (req, res) => {
    const {
        name, categoryId, cityId, startsAt, endsAt,
        targetGroupSize, eventType,
        venueName, venueAddress, description, organizerId
    } = req.body;

    const validationError = validateEventFields(req.body, { partial: false });
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }
    if (!categoryId) {
        return res.status(400).json({ error: 'categoryId is required' });
    }
    if (!cityId) {
        return res.status(400).json({ error: 'cityId is required' });
    }

    // Categories are optional at create — an event may start as a draft and be
    // configured afterwards, the same create-then-configure flow images and
    // the artist lineup already use. A category-less event simply can't be
    // purchased; Part 4 enforces that at checkout.
    const categories = req.body.categories;
    if (categories !== undefined) {
        const categoriesError = validateCategoriesPayload(categories);
        if (categoriesError) {
            return res.status(400).json({ error: categoriesError });
        }
    }

    const client = await pool.connect();

    try {
        const categoryCheck = await client.query('SELECT id FROM event_categories WHERE id = $1', [categoryId]);
        if (categoryCheck.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid categoryId' });
        }

        const cityCheck = await client.query('SELECT id FROM cities WHERE id = $1', [cityId]);
        if (cityCheck.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid cityId' });
        }

        if (organizerId) {
            const organizerCheck = await client.query('SELECT id FROM organizers WHERE id = $1', [organizerId]);
            if (organizerCheck.rows.length === 0) {
                return res.status(400).json({ error: 'Invalid organizerId' });
            }
        }

        await client.query('BEGIN');

        const inserted = await client.query(
            `INSERT INTO events (
                name, category_id, city_id, starts_at, ends_at,
                price, capacity, target_group_size, event_type,
                venue_name, venue_address, description, organizer_id,
                require_facebook, require_instagram, require_linkedin
             ) VALUES (
                $1, $2, $3, $4, $5,
                COALESCE($6, 0), $7, $8, COALESCE($9, 'open'),
                $10, $11, $12, $13,
                COALESCE($14, false), COALESCE($15, false), COALESCE($16, false)
             )
             RETURNING *`,
            [
                name.trim(), categoryId, cityId, startsAt, endsAt ?? null,
                // price/capacity are written as dead defaults: the price
                // column is NOT NULL and both are vestigial. Nothing reads
                // them; a later cleanup drops the columns.
                null, null, targetGroupSize, eventType ?? null,
                venueName ?? null, venueAddress ?? null, description ?? null, organizerId ?? null,
                req.body.requireFacebook ?? null, req.body.requireInstagram ?? null, req.body.requireLinkedin ?? null
            ]
        );
        const event = inserted.rows[0];

        if (categories !== undefined) {
            const catalogError = await validateCatalogIds(client, categories);
            if (catalogError) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: catalogError });
            }
            await replaceEventCategories(client, event.id, categories);
        }

        await recordAudit(client, {
            adminId: req.admin.adminId,
            action: 'create',
            entityType: 'event',
            entityId: event.id,
            changes: {
                ...toResponse(event),
                ...(categories !== undefined ? { categories } : {})
            }
        });

        await client.query('COMMIT');

        const saved = await fetchEventCategories(event.id);
        res.status(201).json({
            event: {
                ...toResponse(event),
                categories: saved,
                capacitySummary: buildCapacitySummary(saved),
                priceRange: priceRange(saved)
            }
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('POST /admin/events error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// GET /admin/events
// Filterable by organizerId, cityId, and status (upcoming|past). List view
// includes bannerUrl (batch-signed) but not the gallery — that's detail-only.
adminEventsRouter.get('/', async (req, res) => {
    const { organizerId, cityId, status } = req.query;

    const conditions = [];
    const values = [];
    let paramCount = 1;

    if (organizerId !== undefined) {
        conditions.push(`e.organizer_id = $${paramCount++}`);
        values.push(organizerId);
    }
    if (cityId !== undefined) {
        conditions.push(`e.city_id = $${paramCount++}`);
        values.push(cityId);
    }
    if (status === 'upcoming') {
        conditions.push('e.starts_at > now()');
    } else if (status === 'past') {
        conditions.push('e.starts_at <= now()');
    } else if (status !== undefined) {
        return res.status(400).json({ error: 'status must be upcoming or past' });
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const result = await pool.query(
            `SELECT e.*, o.display_name AS organizer_name
             FROM events e
             LEFT JOIN organizers o ON o.id = e.organizer_id
             ${where}
             ORDER BY e.starts_at DESC`,
            values
        );

        const bannerKeys = result.rows.map(r => r.banner_s3_key).filter(Boolean);
        const viewUrls = await getPhotoViewUrls(bannerKeys);

        // One aggregate query for the whole page, not one per event. Uses the
        // same derivation as the detail endpoint, so a given event's numbers
        // are identical in both — the list cannot drift from the detail.
        const summaries = await categorySummariesForEvents(result.rows.map(r => r.id));

        res.json({
            events: result.rows.map(row => ({
                ...toResponse(row),
                capacitySummary: summaries[row.id].capacitySummary,
                priceRange:      summaries[row.id].priceRange,
                bannerUrl:     row.banner_s3_key ? viewUrls[row.banner_s3_key] : null,
                organizerName: row.organizer_name ?? null
            }))
        });

    } catch (err) {
        console.error('GET /admin/events error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /admin/events/:id
// Full detail: banner + gallery (both presigned) + organizer.
adminEventsRouter.get('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `SELECT e.*, o.id AS org_id, o.email AS org_email, o.display_name AS org_display_name
             FROM events e
             LEFT JOIN organizers o ON o.id = e.organizer_id
             WHERE e.id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        const row = result.rows[0];

        const galleryResult = await pool.query(
            'SELECT id, s3_key, position FROM event_photos WHERE event_id = $1 ORDER BY position ASC',
            [id]
        );

        const allKeys = [row.banner_s3_key, ...galleryResult.rows.map(p => p.s3_key)].filter(Boolean);
        const viewUrls = await getPhotoViewUrls(allKeys);

        const categories = await fetchEventCategories(id);

        res.json({
            event: {
                ...toResponse(row),
                categories,
                capacitySummary: buildCapacitySummary(categories),
                priceRange: priceRange(categories),
                bannerUrl: row.banner_s3_key ? viewUrls[row.banner_s3_key] : null,
                // s3Key is exposed here (admin only) because PUT /gallery is a
                // full replace — to keep an existing photo the admin has to
                // send its key back. Consumer responses stay key-free.
                gallery: galleryResult.rows.map(p => ({
                    id:       p.id,
                    s3Key:    p.s3_key,
                    url:      viewUrls[p.s3_key],
                    position: p.position
                })),
                organizer: row.org_id ? {
                    id:          row.org_id,
                    email:       row.org_email,
                    displayName: row.org_display_name
                } : null
            }
        });

    } catch (err) {
        console.error('GET /admin/events/:id error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /admin/events/:id
// Partial update — any field editable, including price and capacity even
// after tickets are sold.
//
// IMPORTANT: editing price/capacity/etc. here does NOT retroactively affect
// existing orders or tickets. orders.js freezes the full price breakdown
// onto the order row at purchase time and never re-reads this events row —
// so edits only ever affect future buyers. This is correct and intended;
// no special handling needed here, this comment is the documentation.
adminEventsRouter.patch('/:id', async (req, res) => {
    const { id } = req.params;
    const { categoryId, cityId, organizerId } = req.body;

    const validationError = validateEventFields(req.body, { partial: true });
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }

    // Sending `categories` replaces the event's whole category set. Omitting
    // it leaves the categories untouched, so a PATCH that only edits the venue
    // can't wipe the ticketing config.
    const categories = req.body.categories;
    if (categories !== undefined) {
        const categoriesError = validateCategoriesPayload(categories);
        if (categoriesError) {
            return res.status(400).json({ error: categoriesError });
        }
    }

    const client = await pool.connect();

    try {
        const beforeResult = await client.query('SELECT * FROM events WHERE id = $1', [id]);
        if (beforeResult.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }
        const before = beforeResult.rows[0];

        if (categoryId !== undefined) {
            const check = await client.query('SELECT id FROM event_categories WHERE id = $1', [categoryId]);
            if (check.rows.length === 0) {
                return res.status(400).json({ error: 'Invalid categoryId' });
            }
        }
        if (cityId !== undefined) {
            const check = await client.query('SELECT id FROM cities WHERE id = $1', [cityId]);
            if (check.rows.length === 0) {
                return res.status(400).json({ error: 'Invalid cityId' });
            }
        }
        if (organizerId !== undefined && organizerId !== null) {
            const check = await client.query('SELECT id FROM organizers WHERE id = $1', [organizerId]);
            if (check.rows.length === 0) {
                return res.status(400).json({ error: 'Invalid organizerId' });
            }
        }

        const fieldValues = {
            name:               req.body.name !== undefined ? req.body.name.trim() : undefined,
            category_id:        categoryId,
            city_id:            cityId,
            starts_at:          req.body.startsAt,
            ends_at:            req.body.endsAt,
            target_group_size:  req.body.targetGroupSize,
            event_type:         req.body.eventType,
            venue_name:         req.body.venueName,
            venue_address:      req.body.venueAddress,
            description:        req.body.description,
            organizer_id:       organizerId,
            require_facebook:   req.body.requireFacebook,
            require_instagram:  req.body.requireInstagram,
            require_linkedin:   req.body.requireLinkedin
        };

        const updates = [];
        const values = [];
        let paramCount = 1;

        for (const column of EDITABLE_COLUMNS) {
            const value = fieldValues[column];
            if (value !== undefined) {
                updates.push(`${column} = $${paramCount++}`);
                values.push(value);
            }
        }

        // A PATCH carrying only `categories` is a legitimate edit — the
        // ticketing config is the change.
        if (updates.length === 0 && categories === undefined) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        values.push(id);

        // Guards run before anything is written, so a rejected category edit
        // leaves the event exactly as it was.
        let existingCategories = [];
        if (categories !== undefined) {
            const existingResult = await client.query(
                `SELECT etc.category_id, tc.name AS category_name
                 FROM event_ticket_categories etc
                 JOIN ticket_categories tc ON tc.id = etc.category_id
                 WHERE etc.event_id = $1`,
                [id]
            );
            existingCategories = existingResult.rows;

            const catalogError = await validateCatalogIds(client, categories, existingCategories);
            if (catalogError) {
                return res.status(400).json({ error: catalogError });
            }

            const soldCounts = await ticketsSoldByCategory(id);
            const blocked = findBlockedCategoryChanges(existingCategories, categories, soldCounts);
            if (blocked) {
                return res.status(409).json({ error: blocked });
            }
        }

        await client.query('BEGIN');

        let after = before;
        if (updates.length > 0) {
            const afterResult = await client.query(
                `UPDATE events
                 SET ${updates.join(', ')}, updated_at = now()
                 WHERE id = $${paramCount}
                 RETURNING *`,
                values
            );
            after = afterResult.rows[0];
        }

        if (categories !== undefined) {
            await replaceEventCategories(client, id, categories);
        }

        const changes = diffChanges(before, after, EDITABLE_COLUMNS);
        if (categories !== undefined) {
            changes.categories = {
                from: existingCategories.map(c => c.category_name),
                to:   categories.map(c => c.categoryId)
            };
        }

        if (Object.keys(changes).length > 0) {
            await recordAudit(client, {
                adminId: req.admin.adminId,
                action: 'update',
                entityType: 'event',
                entityId: id,
                changes
            });
        }

        await client.query('COMMIT');

        const savedCategories = await fetchEventCategories(id);
        res.json({
            event: {
                ...toResponse(after),
                categories: savedCategories,
                capacitySummary: buildCapacitySummary(savedCategories),
                priceRange: priceRange(savedCategories)
            }
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('PATCH /admin/events/:id error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// POST /admin/events/:id/image-url
// Presigned PUT URL for an event image, same handshake as profile photos.
// Body: { contentType, kind: 'banner' | 'gallery' }
adminEventsRouter.post('/:id/image-url', async (req, res) => {
    const { id } = req.params;
    const { contentType, kind } = req.body;

    if (!contentType) {
        return res.status(400).json({ error: 'contentType is required' });
    }
    if (!['banner', 'gallery'].includes(kind)) {
        return res.status(400).json({ error: "kind must be 'banner' or 'gallery'" });
    }

    try {
        const eventCheck = await pool.query('SELECT id FROM events WHERE id = $1', [id]);
        if (eventCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        const { uploadUrl, key } = await createEventImageUploadUrl(id, kind, contentType);
        res.json({ uploadUrl, key });

    } catch (err) {
        if (err.message === 'UNSUPPORTED_TYPE') {
            return res.status(400).json({ error: 'Only JPEG, PNG, and WebP images are allowed' });
        }
        console.error('POST /admin/events/:id/image-url error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /admin/events/:id/banner
// Verifies the object exists in S3 before saving — same all-or-nothing
// pattern as profile photos.
adminEventsRouter.patch('/:id/banner', async (req, res) => {
    const { id } = req.params;
    const { s3Key } = req.body;

    if (!s3Key) {
        return res.status(400).json({ error: 's3Key is required' });
    }

    const client = await pool.connect();

    try {
        const eventCheck = await client.query('SELECT id, banner_s3_key FROM events WHERE id = $1', [id]);
        if (eventCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }
        const before = eventCheck.rows[0];

        const exists = await objectExists(s3Key);
        if (!exists) {
            return res.status(400).json({ error: 'The image was not uploaded successfully. Please try again.' });
        }

        await client.query('BEGIN');

        await client.query(
            'UPDATE events SET banner_s3_key = $1, updated_at = now() WHERE id = $2',
            [s3Key, id]
        );

        await recordAudit(client, {
            adminId: req.admin.adminId,
            action: 'update',
            entityType: 'event',
            entityId: id,
            changes: { banner_s3_key: { from: before.banner_s3_key, to: s3Key } }
        });

        await client.query('COMMIT');

        const bannerUrl = await getPhotoViewUrl(s3Key);
        res.json({ bannerUrl });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('PATCH /admin/events/:id/banner error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// PUT /admin/events/:id/gallery
// Replaces the entire gallery — delete-and-reinsert in a transaction, same
// pattern as profile photos. Max 5, positions 0-4, all-or-nothing S3
// verification before anything is saved.
adminEventsRouter.put('/:id/gallery', async (req, res) => {
    const { id } = req.params;
    const { photos } = req.body;

    if (!Array.isArray(photos) || photos.length > 5) {
        return res.status(400).json({ error: 'Provide at most 5 photos' });
    }
    for (const photo of photos) {
        if (!photo.s3Key) {
            return res.status(400).json({ error: 'Each photo must have an s3Key' });
        }
        if (!Number.isInteger(photo.position) || photo.position < 0 || photo.position > 4) {
            return res.status(400).json({ error: 'Each photo must have a position between 0 and 4' });
        }
    }
    const positions = photos.map(p => p.position);
    if (new Set(positions).size !== positions.length) {
        return res.status(400).json({ error: 'Each photo must have a unique position' });
    }

    try {
        const eventCheck = await pool.query('SELECT id FROM events WHERE id = $1', [id]);
        if (eventCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        // Verify every claimed upload actually landed in S3 before saving
        // anything. All-or-nothing — a partial gallery is worse than
        // rejecting the whole request.
        for (const photo of photos) {
            const exists = await objectExists(photo.s3Key);
            if (!exists) {
                return res.status(400).json({ error: 'One or more images were not uploaded successfully. Please try again.' });
            }
        }
    } catch (err) {
        console.error('PUT /admin/events/:id/gallery verification error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        await client.query('DELETE FROM event_photos WHERE event_id = $1', [id]);

        for (const photo of photos) {
            await client.query(
                'INSERT INTO event_photos (event_id, s3_key, position) VALUES ($1, $2, $3)',
                [id, photo.s3Key, photo.position]
            );
        }

        await recordAudit(client, {
            adminId: req.admin.adminId,
            action: 'update',
            entityType: 'event',
            entityId: id,
            changes: { gallery: { to: photos.map(p => ({ s3Key: p.s3Key, position: p.position })) } }
        });

        await client.query('COMMIT');

        const viewUrls = await getPhotoViewUrls(photos.map(p => p.s3Key));
        res.json({
            gallery: photos
                .slice()
                .sort((a, b) => a.position - b.position)
                .map(p => ({ s3Key: p.s3Key, url: viewUrls[p.s3Key], position: p.position }))
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('PUT /admin/events/:id/gallery error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// ─── Lineup / artists ────────────────────────────────────────────────────
//
// Artists are event-scoped rows, not a global catalogue — the same performer
// at two events is two rows. See the migration for why.
//
// Editing model (Option A, mirroring the gallery's create-then-upload flow):
// PUT owns the text fields and the set membership; photos are attached
// separately per artist, keyed to the artist id. PUT is therefore an
// upsert-by-id rather than a delete-and-reinsert — reinserting would throw
// away photo_s3_key for artists that survived the edit.

const MAX_ARTISTS = 10;

async function fetchArtists(eventId, queryable = pool) {
    const result = await queryable.query(
        `SELECT id, name, instagram, photo_s3_key, position
         FROM event_artists
         WHERE event_id = $1
         ORDER BY position ASC`,
        [eventId]
    );

    const keys = result.rows.map(a => a.photo_s3_key).filter(Boolean);
    const viewUrls = await getPhotoViewUrls(keys);

    return result.rows.map(a => ({
        id:        a.id,
        name:      a.name,
        instagram: a.instagram,
        photoUrl:  a.photo_s3_key ? viewUrls[a.photo_s3_key] : null,
        position:  a.position
    }));
}

// GET /admin/events/:id/artists
adminEventsRouter.get('/:id/artists', async (req, res) => {
    const { id } = req.params;

    try {
        const eventCheck = await pool.query('SELECT id FROM events WHERE id = $1', [id]);
        if (eventCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        res.json({ artists: await fetchArtists(id) });

    } catch (err) {
        console.error('GET /admin/events/:id/artists error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /admin/events/:id/artists
// Sets the whole lineup. Each entry may carry an `id` to update an existing
// artist (keeping its photo); entries without one are created. Any artist not
// present in the payload is deleted, and its photo key goes with it.
adminEventsRouter.put('/:id/artists', async (req, res) => {
    const { id } = req.params;
    const { artists } = req.body;

    if (!Array.isArray(artists)) {
        return res.status(400).json({ error: 'artists must be an array' });
    }
    if (artists.length > MAX_ARTISTS) {
        return res.status(400).json({ error: `Provide at most ${MAX_ARTISTS} artists` });
    }

    const normalized = [];
    for (const artist of artists) {
        if (!artist.name || !String(artist.name).trim()) {
            return res.status(400).json({ error: 'Each artist must have a name' });
        }
        if (!Number.isInteger(artist.position) || artist.position < 0 || artist.position > MAX_ARTISTS - 1) {
            return res.status(400).json({ error: `Each artist must have a position between 0 and ${MAX_ARTISTS - 1}` });
        }
        let instagram;
        try {
            instagram = normalizeInstagram(artist.instagram);
        } catch {
            return res.status(400).json({ error: `Invalid Instagram handle for "${String(artist.name).trim()}"` });
        }
        normalized.push({ id: artist.id, name: String(artist.name).trim(), instagram, position: artist.position });
    }

    const positions = normalized.map(a => a.position);
    if (new Set(positions).size !== positions.length) {
        return res.status(400).json({ error: 'Each artist must have a unique position' });
    }

    const client = await pool.connect();

    try {
        const eventCheck = await client.query('SELECT id FROM events WHERE id = $1', [id]);
        if (eventCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        const existingResult = await client.query(
            'SELECT id, name, instagram, position FROM event_artists WHERE event_id = $1',
            [id]
        );
        const existingIds = new Set(existingResult.rows.map(a => a.id));

        // An id the caller invented, or one belonging to another event, would
        // silently become an insert and orphan the real row — reject instead.
        for (const artist of normalized) {
            if (artist.id !== undefined && !existingIds.has(artist.id)) {
                return res.status(400).json({ error: 'One or more artist ids do not belong to this event' });
            }
        }

        await client.query('BEGIN');

        const keptIds = normalized.filter(a => a.id !== undefined).map(a => a.id);
        const removed = await client.query(
            `DELETE FROM event_artists
             WHERE event_id = $1 AND NOT (id = ANY($2::uuid[]))
             RETURNING id, name`,
            [id, keptIds]
        );

        // The UNIQUE (event_id, position) constraint is DEFERRABLE INITIALLY
        // DEFERRED, so a reorder can pass through a transiently duplicated
        // position and still be validated at COMMIT.
        for (const artist of normalized) {
            if (artist.id !== undefined) {
                await client.query(
                    `UPDATE event_artists SET name = $1, instagram = $2, position = $3
                     WHERE id = $4 AND event_id = $5`,
                    [artist.name, artist.instagram, artist.position, artist.id, id]
                );
            } else {
                await client.query(
                    `INSERT INTO event_artists (event_id, name, instagram, position)
                     VALUES ($1, $2, $3, $4)`,
                    [id, artist.name, artist.instagram, artist.position]
                );
            }
        }

        await recordAudit(client, {
            adminId: req.admin.adminId,
            action: 'update',
            entityType: 'event',
            entityId: id,
            changes: {
                artists: {
                    from: existingResult.rows
                        .slice()
                        .sort((a, b) => a.position - b.position)
                        .map(a => ({ name: a.name, instagram: a.instagram, position: a.position })),
                    to: normalized
                        .slice()
                        .sort((a, b) => a.position - b.position)
                        .map(a => ({ name: a.name, instagram: a.instagram, position: a.position })),
                    removed: removed.rows.map(a => a.name)
                }
            }
        });

        await client.query('COMMIT');

        res.json({ artists: await fetchArtists(id) });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('PUT /admin/events/:id/artists error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// POST /admin/events/:id/artists/:artistId/image-url
// Presigned upload handshake — same two-step as event images. The artist must
// already exist, so its id can namespace the key.
adminEventsRouter.post('/:id/artists/:artistId/image-url', async (req, res) => {
    const { id, artistId } = req.params;
    const { contentType } = req.body;

    if (!contentType) {
        return res.status(400).json({ error: 'contentType is required' });
    }

    try {
        const artistCheck = await pool.query(
            'SELECT id FROM event_artists WHERE id = $1 AND event_id = $2',
            [artistId, id]
        );
        if (artistCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Artist not found' });
        }

        const { uploadUrl, key } = await createArtistPhotoUploadUrl(id, artistId, contentType);
        res.json({ uploadUrl, key });

    } catch (err) {
        if (err.message === 'UNSUPPORTED_TYPE') {
            return res.status(400).json({ error: 'Only JPEG, PNG, and WebP images are allowed' });
        }
        console.error('POST /admin/events/:id/artists/:artistId/image-url error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /admin/events/:id/artists/:artistId/photo
// Attaches an uploaded photo. Verifies the object landed in S3 first, same
// all-or-nothing rule as the banner. Pass s3Key: null to clear the photo.
adminEventsRouter.patch('/:id/artists/:artistId/photo', async (req, res) => {
    const { id, artistId } = req.params;
    const { s3Key } = req.body;

    if (s3Key === undefined) {
        return res.status(400).json({ error: 's3Key is required' });
    }

    const client = await pool.connect();

    try {
        const artistCheck = await client.query(
            'SELECT id, name, photo_s3_key FROM event_artists WHERE id = $1 AND event_id = $2',
            [artistId, id]
        );
        if (artistCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Artist not found' });
        }
        const before = artistCheck.rows[0];

        if (s3Key !== null) {
            // The key is server-generated and namespaced to this artist —
            // reject one pointing anywhere else, so a caller can't attach
            // another artist's (or another event's) photo.
            if (!s3Key.startsWith(`events/${id}/artists/${artistId}/`)) {
                return res.status(400).json({ error: 's3Key does not belong to this artist' });
            }
            const exists = await objectExists(s3Key);
            if (!exists) {
                return res.status(400).json({ error: 'The image was not uploaded successfully. Please try again.' });
            }
        }

        await client.query('BEGIN');

        await client.query(
            'UPDATE event_artists SET photo_s3_key = $1 WHERE id = $2 AND event_id = $3',
            [s3Key, artistId, id]
        );

        await recordAudit(client, {
            adminId: req.admin.adminId,
            action: 'update',
            entityType: 'event',
            entityId: id,
            changes: {
                artistPhoto: {
                    artistId,
                    artistName: before.name,
                    from: before.photo_s3_key,
                    to: s3Key
                }
            }
        });

        await client.query('COMMIT');

        const photoUrl = s3Key ? await getPhotoViewUrl(s3Key) : null;
        res.json({ artistId, photoUrl });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('PATCH /admin/events/:id/artists/:artistId/photo error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

export default adminEventsRouter;
