import express from 'express';
import { pool } from '../config/db.js';
import authenticateOrganizer from '../middlewares/authenticateOrganizer.js';
import { getPhotoViewUrls } from '../utils/s3.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import { fetchAttendeeProfiles } from '../utils/organizerAttendee.js';
import {
    categorySummariesForEvents,
    fetchEventCategories,
    buildCapacitySummary,
    priceRange
} from '../utils/eventCategories.js';

const organizerEventsRouter = express.Router();

const ALLOWED_INVITATION_STATUSES = ['pending', 'accepted', 'rejected'];

// Every endpoint here is read-only and scoped to the logged-in organizer.
// No PATCH/POST/DELETE — organizers contact admin to change event details.
organizerEventsRouter.use(authenticateOrganizer);

// GET /organizer/events
// Only this organizer's events — WHERE organizer_id = req.organizer.organizerId,
// never from a request parameter.
organizerEventsRouter.get('/', async (req, res) => {
    const organizerId = req.organizer.organizerId;
    const { limit, offset } = parsePagination(req.query);

    try {
        const countResult = await pool.query('SELECT COUNT(*) FROM events WHERE organizer_id = $1', [organizerId]);

        const dataResult = await pool.query(
            // "What's coming up", not "what's furthest away". Upcoming events
            // first, soonest at the top; past events below, most recent first,
            // so a just-finished event is the first of the past group rather
            // than an ancient one.
            //
            // Past events are ordered, not filtered — an organizer still needs
            // a finished event to pull its attendee list.
            //
            // The boundary is starts_at >= now() counts as upcoming, so an
            // event starting this instant is still "coming up".
            //
            // e.id is the unique tiebreaker: without it, two events at the
            // same starts_at could order differently between pages and
            // LIMIT/OFFSET would skip or repeat rows.
            `SELECT e.*, (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id) AS tickets_sold
             FROM events e
             WHERE e.organizer_id = $1
             ORDER BY
                (e.starts_at < now()) ASC,
                CASE WHEN e.starts_at >= now() THEN e.starts_at END ASC  NULLS LAST,
                CASE WHEN e.starts_at <  now() THEN e.starts_at END DESC NULLS LAST,
                e.id ASC
             LIMIT $2 OFFSET $3`,
            [organizerId, limit, offset]
        );

        const bannerKeys = dataResult.rows.map(e => e.banner_s3_key).filter(Boolean);
        const viewUrls = await getPhotoViewUrls(bannerKeys);

        const summaries = await categorySummariesForEvents(dataResult.rows.map(e => e.id));

        const data = dataResult.rows.map(e => ({
            id:           e.id,
            name:         e.name,
            categoryId:   e.category_id,
            cityId:       e.city_id,
            startsAt:     e.starts_at,
            venueName:    e.venue_name,
            venueAddress: e.venue_address,
            eventType:    e.event_type,
            // Capacity is derived from the tiers now, not the vestigial
            // events.capacity column.
            priceRange:      summaries[e.id].priceRange,
            capacitySummary: summaries[e.id].capacitySummary,
            bannerUrl:    e.banner_s3_key ? viewUrls[e.banner_s3_key] : null,
            ticketsSold:  parseInt(e.tickets_sold, 10)
        }));

        res.json(paginatedResponse(data, countResult.rows[0].count, limit, offset));

    } catch (err) {
        console.error('GET /organizer/events error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /organizer/events/:id
// Ownership-checked — 404 (not 403) if the event isn't theirs, so we never
// confirm the event even exists to an organizer who shouldn't see it.
organizerEventsRouter.get('/:id', async (req, res) => {
    const { id } = req.params;
    const organizerId = req.organizer.organizerId;

    try {
        const eventResult = await pool.query(
            'SELECT * FROM events WHERE id = $1 AND organizer_id = $2',
            [id, organizerId]
        );

        if (eventResult.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        const e = eventResult.rows[0];

        const galleryResult = await pool.query(
            'SELECT id, s3_key, position FROM event_photos WHERE event_id = $1 ORDER BY position ASC',
            [id]
        );

        const allKeys = [e.banner_s3_key, ...galleryResult.rows.map(p => p.s3_key)].filter(Boolean);
        const viewUrls = await getPhotoViewUrls(allKeys);

        const organizerCategories = await fetchEventCategories(id);

        const ticketsSoldResult = await pool.query('SELECT COUNT(*) FROM tickets WHERE event_id = $1', [id]);

        // Gross collected on paid orders for this event — informational
        // only. This is NOT a payout figure; settlement is a separate,
        // future feature (commissions, fees, etc. aren't modeled yet).
        const grossResult = await pool.query(
            `SELECT COALESCE(SUM(total_paise), 0) AS gross_sales_paise
             FROM orders WHERE event_id = $1 AND status = 'paid'`,
            [id]
        );

        res.json({
            event: {
                id:              e.id,
                name:            e.name,
                categoryId:      e.category_id,
                cityId:          e.city_id,
                startsAt:        e.starts_at,
                endsAt:          e.ends_at,
                // Price and capacity are per-tier now. The organizer sees the
                // configured tiers rather than a single event-level number.
                ticketCategories: organizerCategories,
                priceRange:      priceRange(organizerCategories),
                capacitySummary: buildCapacitySummary(organizerCategories),
                targetGroupSize: e.target_group_size,
                eventType:       e.event_type,
                venueName:       e.venue_name,
                venueAddress:    e.venue_address,
                description:     e.description,
                bannerUrl:       e.banner_s3_key ? viewUrls[e.banner_s3_key] : null,
                gallery: galleryResult.rows.map(p => ({
                    id:       p.id,
                    url:      viewUrls[p.s3_key],
                    position: p.position
                })),
                ticketsSold:     parseInt(ticketsSoldResult.rows[0].count, 10),
                // Gross collected, not a payout figure — see comment above.
                grossSalesPaise: parseInt(grossResult.rows[0].gross_sales_paise, 10)
            }
        });

    } catch (err) {
        console.error('GET /organizer/events/:id error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /organizer/events/:id/attendees
// Ticket-holders as profile cards. Deliberately no phone/email anywhere in
// this response — see src/utils/organizerAttendee.js, the single place
// that ever selects organizer-facing profile data from the DB.
organizerEventsRouter.get('/:id/attendees', async (req, res) => {
    const { id } = req.params;
    const organizerId = req.organizer.organizerId;
    const { limit, offset } = parsePagination(req.query);

    try {
        const ownCheck = await pool.query(
            'SELECT id FROM events WHERE id = $1 AND organizer_id = $2',
            [id, organizerId]
        );
        if (ownCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        const countResult = await pool.query('SELECT COUNT(*) FROM tickets WHERE event_id = $1', [id]);

        const ticketsResult = await pool.query(
            `SELECT id AS ticket_id, user_id, checked_in_at
             FROM tickets
             WHERE event_id = $1
             ORDER BY created_at DESC, id DESC
             LIMIT $2 OFFSET $3`,
            [id, limit, offset]
        );

        const userIds = ticketsResult.rows.map(t => t.user_id);
        const profiles = await fetchAttendeeProfiles(userIds);

        const data = ticketsResult.rows.map(t => ({
            ticketId:    t.ticket_id,
            checkedIn:   t.checked_in_at !== null,
            checkedInAt: t.checked_in_at,
            ...profiles[t.user_id]
        }));

        res.json(paginatedResponse(data, countResult.rows[0].count, limit, offset));

    } catch (err) {
        console.error('GET /organizer/events/:id/attendees error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /organizer/events/:id/invitations
// Ownership-checked via the event, not the invitation's own organizer_id
// snapshot — avoids staleness if an event was reassigned after invitations
// existed. Same profile-only card as attendees, no phone/email.
organizerEventsRouter.get('/:id/invitations', async (req, res) => {
    const { id } = req.params;
    const organizerId = req.organizer.organizerId;
    const status = req.query.status ?? 'pending';
    const { limit, offset } = parsePagination(req.query);

    if (!ALLOWED_INVITATION_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${ALLOWED_INVITATION_STATUSES.join(', ')}` });
    }

    try {
        const ownCheck = await pool.query(
            'SELECT id FROM events WHERE id = $1 AND organizer_id = $2',
            [id, organizerId]
        );
        if (ownCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        const countResult = await pool.query(
            'SELECT COUNT(*) FROM event_invitations WHERE event_id = $1 AND status = $2',
            [id, status]
        );

        const invResult = await pool.query(
            `SELECT id AS invitation_id, user_id, status, created_at AS requested_at
             FROM event_invitations
             WHERE event_id = $1 AND status = $2
             ORDER BY created_at DESC, id DESC
             LIMIT $3 OFFSET $4`,
            [id, status, limit, offset]
        );

        const userIds = invResult.rows.map(i => i.user_id);
        const profiles = await fetchAttendeeProfiles(userIds);

        const data = invResult.rows.map(i => ({
            invitationId: i.invitation_id,
            status:       i.status,
            requestedAt:  i.requested_at,
            ...profiles[i.user_id]
        }));

        res.json(paginatedResponse(data, countResult.rows[0].count, limit, offset));

    } catch (err) {
        console.error('GET /organizer/events/:id/invitations error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default organizerEventsRouter;
