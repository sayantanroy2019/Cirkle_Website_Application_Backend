import express from 'express';
import {pool}    from '../config/db.js';
import authenticate from '../middlewares/auth.js';
import { getPhotoViewUrls } from '../utils/s3.js';
import { checkRequiredHandles, socialHandlesRequiredResponse } from '../utils/socialGate.js';
import { fetchPublicAttendeeProfiles } from '../utils/publicAttendee.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';

const eventsRouter = express.Router();

// GET /events
// Returns city-filtered events for the Feed
// City defaults to user's profile city — overridable via ?city= param
// Optional ?category= filter for the Events tab filter chips
eventsRouter.get('/', authenticate, async (req, res) => {
    const { city, category } = req.query;

    try {
        // Step 1: get user's profile city as default
        const profileResult = await pool.query(
            'SELECT city_id FROM profiles WHERE user_id = $1',
            [req.user.userId]
        );

        if (profileResult.rows.length === 0) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        const defaultCity = profileResult.rows[0].city_id;

        // Step 2: determine active city
        // If ?city= provided, validate it exists — else fall back to profile city
        let activeCity = defaultCity;

        if (city !== undefined) {
            const cityCheck = await pool.query(
                'SELECT id FROM cities WHERE id = $1',
                [city]
            );
            if (cityCheck.rows.length === 0) {
                return res.status(400).json({ error: 'Invalid city' });
            }
            activeCity = city;
        }

        // Step 3: validate category if provided
        if (category !== undefined) {
            const categoryCheck = await pool.query(
                'SELECT id FROM event_categories WHERE id = $1',
                [category]
            );
            if (categoryCheck.rows.length === 0) {
                return res.status(400).json({ error: 'Invalid category' });
            }
        }

        // Step 4: build dynamic query
        // Filter by city always; filter by category only if provided
        const conditions = ['city_id = $1'];
        const values = [activeCity];
        let paramCount = 2;

        if (category !== undefined) {
            conditions.push(`category_id = $${paramCount++}`);
            values.push(category);
        }

        const eventsResult = await pool.query(
            `SELECT
                id,
                name,
                category_id,
                city_id,
                starts_at,
                ends_at,
                price,
                target_group_size,
                venue_name,
                venue_address,
                description,
                banner_s3_key
             FROM events
             WHERE ${conditions.join(' AND ')}
             ORDER BY starts_at ASC`,
            values
        );

        // Bucket is private — sign all banner keys in one batch rather than per-event
        const bannerKeys = eventsResult.rows.map(e => e.banner_s3_key).filter(Boolean);
        const viewUrls = await getPhotoViewUrls(bannerKeys);

        res.json({
            events: eventsResult.rows.map(e => ({
                id:              e.id,
                name:            e.name,
                categoryId:      e.category_id,
                cityId:          e.city_id,
                startsAt:        e.starts_at,
                endsAt:          e.ends_at,
                price:           e.price,
                targetGroupSize: e.target_group_size,
                venueName:       e.venue_name,
                venueAddress:    e.venue_address,
                description:     e.description,
                bannerUrl:       e.banner_s3_key ? viewUrls[e.banner_s3_key] : null
            }))
        });

    } catch (err) {
        console.error('GET /events error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /events/:id
// Returns a single event by ID — generic state (no group context)
// Groups phase adds the via-anchor state on top of this
// GET /events/:id
// Single event, generic state. Now also returns the two flags the buy button
// needs: whether this user already holds a ticket, and whether the event is
// sold out. Both are server-only facts the frontend can't compute.
eventsRouter.get('/:id', authenticate, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `SELECT
                e.id, e.name, e.category_id, e.city_id,
                e.starts_at, e.ends_at, e.price, e.target_group_size,
                e.venue_name, e.venue_address, e.description, e.banner_s3_key,
                e.capacity, e.event_type,
                e.require_facebook, e.require_instagram, e.require_linkedin,
                -- Only the handle, nothing else about the organizer. This is
                -- for an Instagram icon link on the detail page; the consumer
                -- response deliberately exposes no organizer name or email.
                o.instagram AS organizer_instagram
             FROM events e
             LEFT JOIN organizers o ON o.id = e.organizer_id
             WHERE e.id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        const e = result.rows[0];

        // Does this user already hold a ticket to this event?
        const ticketCheck = await pool.query(
            'SELECT id FROM tickets WHERE user_id = $1 AND event_id = $2',
            [req.user.userId, id]
        );
        const userHasTicket = ticketCheck.rows.length > 0;

        // Sold out? Only meaningful for capped events.
        // taken = confirmed tickets + live holds, same formula as order creation.
        let soldOut = false;
        if (e.capacity !== null) {
            const taken = await pool.query(
                `SELECT
                    (SELECT COUNT(*) FROM tickets WHERE event_id = $1)
                  + (SELECT COUNT(*) FROM orders
                     WHERE event_id = $1 AND status = 'created' AND expires_at > now())
                 AS taken`,
                [id]
            );
            soldOut = parseInt(taken.rows[0].taken, 10) >= e.capacity;
        }

        // Invitation status — only meaningful for invite-only events.
        // null means "no request yet" (or an open event, where it's irrelevant).
        let invitationStatus = null;
        if (e.event_type === 'invite_only') {
            const inv = await pool.query(
                'SELECT status FROM event_invitations WHERE user_id = $1 AND event_id = $2',
                [req.user.userId, id]
            );
            invitationStatus = inv.rows.length > 0 ? inv.rows[0].status : null;
        }

        // Gallery — up to 5 additional images, separate from the single banner
        const galleryResult = await pool.query(
            'SELECT s3_key, position FROM event_photos WHERE event_id = $1 ORDER BY position ASC',
            [id]
        );

        // Lineup — ordered, headliner (position 0) first
        const artistsResult = await pool.query(
            `SELECT id, name, instagram, photo_s3_key, position
             FROM event_artists
             WHERE event_id = $1
             ORDER BY position ASC`,
            [id]
        );

        // Bucket is private — sign banner + gallery + artist keys in one batch
        const allKeys = [
            e.banner_s3_key,
            ...galleryResult.rows.map(p => p.s3_key),
            ...artistsResult.rows.map(a => a.photo_s3_key)
        ].filter(Boolean);
        const viewUrls = await getPhotoViewUrls(allKeys);

        res.json({
            event: {
                id:              e.id,
                name:            e.name,
                categoryId:      e.category_id,
                cityId:          e.city_id,
                startsAt:        e.starts_at,
                endsAt:          e.ends_at,
                price:           e.price,
                targetGroupSize: e.target_group_size,
                venueName:       e.venue_name,
                venueAddress:    e.venue_address,
                description:     e.description,
                bannerUrl:       e.banner_s3_key ? viewUrls[e.banner_s3_key] : null,
                gallery:         galleryResult.rows.map(p => ({
                    url:      viewUrls[p.s3_key],
                    position: p.position
                })),
                artists:         artistsResult.rows.map(a => ({
                    id:        a.id,
                    name:      a.name,
                    instagram: a.instagram,
                    photoUrl:  a.photo_s3_key ? viewUrls[a.photo_s3_key] : null,
                    position:  a.position
                })),
                organizerInstagram: e.organizer_instagram ?? null,
                // Exposed so the app can warn before the gate fires. The gate
                // itself is enforced server-side at purchase/request — these
                // flags are UX, not the boundary.
                requireFacebook:  e.require_facebook,
                requireInstagram: e.require_instagram,
                requireLinkedin:  e.require_linkedin,
                userHasTicket,
                soldOut,
                eventType:        e.event_type,
                invitationStatus
            }
        });

    } catch (err) {
        console.error('GET /events/:id error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /events/:id/attendees
// The "Who's Going" roster. Readable by ANY logged-in user viewing the event —
// holding a ticket is not required. That's deliberate: the list is social proof
// that drives bookings, so gating it behind a purchase would defeat its point.
//
// Not the organizer endpoint's data. This uses fetchPublicAttendeeProfiles(),
// whose SELECT excludes last_name, bio and the social handles that the
// organizer card deliberately includes. See src/utils/publicAttendee.js.
eventsRouter.get('/:id/attendees', authenticate, async (req, res) => {
    const { id: eventId } = req.params;
    const { limit, offset } = parsePagination(req.query);

    try {
        const eventCheck = await pool.query('SELECT id FROM events WHERE id = $1', [eventId]);
        if (eventCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        // One row per person, not per ticket. Checkout already enforces one
        // ticket per user per event, so this is belt-and-braces — but the
        // organizer endpoint pages over tickets and this one must not, or a
        // double-ticketed user would appear twice and inflate the count.
        const countResult = await pool.query(
            'SELECT COUNT(DISTINCT user_id) FROM tickets WHERE event_id = $1',
            [eventId]
        );

        // Newest attendee first. The id tiebreaker is required, not cosmetic:
        // created_at ties are common (bulk inserts, same-second checkouts) and
        // without a unique sort key LIMIT/OFFSET silently drops and repeats
        // rows across pages.
        const attendeesResult = await pool.query(
            `SELECT d.user_id, d.created_at, d.id
             FROM (
                SELECT DISTINCT ON (t.user_id) t.user_id, t.created_at, t.id
                FROM tickets t
                WHERE t.event_id = $1
                ORDER BY t.user_id, t.created_at DESC, t.id DESC
             ) d
             ORDER BY d.created_at DESC, d.id DESC
             LIMIT $2 OFFSET $3`,
            [eventId, limit, offset]
        );

        const userIds = attendeesResult.rows.map(r => r.user_id);
        const profiles = await fetchPublicAttendeeProfiles(userIds);

        // The viewer is included when they hold a ticket, flagged rather than
        // filtered — "24 attending" has to mean 24 people, and dropping self
        // would make the count disagree with the roster.
        const data = attendeesResult.rows
            .map(r => profiles[r.user_id])
            .filter(Boolean)   // a ticket-holder who never completed onboarding
            .map(person => ({ ...person, isYou: person.id === req.user.userId }));

        res.json(paginatedResponse(data, countResult.rows[0].count, limit, offset));

    } catch (err) {
        console.error('GET /events/:id/attendees error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /events/:id/invitations
// User requests access to an invite-only event. Creates a 'pending' row.
// The UNIQUE(user_id, event_id) constraint enforces every rule here:
//   - can't request twice while pending
//   - can't re-request after rejection
//   - can't request again after acceptance
eventsRouter.post('/:id/invitations', authenticate, async (req, res) => {
    const { id: eventId } = req.params;
    const userId = req.user.userId;

    try {
        // Event must exist and be invite-only
        const eventResult = await pool.query(
            `SELECT id, event_type, organizer_id,
                    require_facebook, require_instagram, require_linkedin
             FROM events WHERE id = $1`,
            [eventId]
        );

        if (eventResult.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        if (eventResult.rows[0].event_type !== 'invite_only') {
            return res.status(400).json({ error: 'This event does not require an invitation' });
        }

        // Social handle gate, before the request is created. Gating here — not
        // at purchase — is what guarantees the organizer sees the required
        // handles on the request card when they decide.
        const profileForGate = await pool.query(
            'SELECT facebook, instagram, linkedin FROM profiles WHERE user_id = $1',
            [userId]
        );
        const gate = checkRequiredHandles(eventResult.rows[0], profileForGate.rows[0] ?? null);
        if (!gate.ok) {
            return res.status(403).json(socialHandlesRequiredResponse(gate.missing));
        }

        // Attempt to create the request. If a row already exists, the UNIQUE
        // constraint fires — we translate that into a clear message based on
        // the existing status rather than a raw 500.
        try {
            const inserted = await pool.query(
                `INSERT INTO event_invitations (user_id, event_id, organizer_id, status)
                 VALUES ($1, $2, $3, 'pending')
                 RETURNING status`,
                [userId, eventId, eventResult.rows[0].organizer_id]
            );
            return res.status(201).json({ status: inserted.rows[0].status });

        } catch (err) {
            if (err.code === '23505') { // unique_violation — already requested
                const existing = await pool.query(
                    'SELECT status FROM event_invitations WHERE user_id = $1 AND event_id = $2',
                    [userId, eventId]
                );
                const status = existing.rows[0].status;
                const messages = {
                    pending:  'You have already requested an invitation',
                    accepted: 'Your invitation is already accepted',
                    rejected: 'Access to this event has been denied'
                };
                return res.status(409).json({ error: messages[status], status });
            }
            throw err;
        }

    } catch (err) {
        console.error('POST /events/:id/invitations error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default eventsRouter;