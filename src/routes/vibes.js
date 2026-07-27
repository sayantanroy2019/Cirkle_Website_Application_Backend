import express from 'express';
import { pool } from '../config/db.js';
import authenticate from '../middlewares/auth.js';
import { getPhotoViewUrls } from '../utils/s3.js';

const vibesRouter = express.Router();

// GET /vibes
// The social-proof discovery feed. One card = one upcoming ticket (a person
// going to an event). Excludes the viewer's own tickets and past events.
//
// Ordering is five tiers based on the viewer's gender + city vs the card's.
// Within each tier: soonest event first, then newest ticket. Capped at 100.
//
// Read-only join across tickets, profiles, photos, tags, events. No new tables.
vibesRouter.get('/', authenticate, async (req, res) => {
    const userId = req.user.userId;

    try {
        // Viewer's own gender + city drive the tier ranking
        const viewer = await pool.query(
            'SELECT gender, city_id FROM profiles WHERE user_id = $1',
            [userId]
        );
        if (viewer.rows.length === 0) {
            return res.status(404).json({ error: 'Profile not found' });
        }
        const viewerGender = viewer.rows[0].gender;
        const viewerCity   = viewer.rows[0].city_id;

        // The tier-rank CASE differs for male vs female viewers; non_binary /
        // prefer_not_to_say viewers get no gender preference (all cards rank equal
        // on tier, so ordering falls entirely to the event-date tiebreak).
        let tierRankSql;
        if (viewerGender === 'man') {
            tierRankSql = `
                CASE
                    WHEN p.gender = 'woman' AND e.city_id = $2 THEN 1
                    WHEN p.gender = 'woman'                     THEN 2
                    WHEN p.gender = 'man'   AND e.city_id = $2 THEN 3
                    WHEN p.gender = 'man'                       THEN 4
                    ELSE 5
                END`;
        } else if (viewerGender === 'woman') {
            tierRankSql = `
                CASE
                    WHEN p.gender = 'man'   AND e.city_id = $2 THEN 1
                    WHEN p.gender = 'woman' AND e.city_id = $2 THEN 2
                    WHEN p.gender = 'man'                       THEN 3
                    WHEN p.gender = 'woman'                     THEN 4
                    ELSE 5
                END`;
        } else {
            // No gender preference — everyone in one tier.
            // Still references $2 so the query text always declares 2 params
            // (Postgres infers the count from what's referenced in the SQL,
            // and the caller always binds [userId, viewerCity]). The ELSE
            // fallback means this is 1 whether the WHEN matches, doesn't
            // match, or is NULL — no NULL-handling edge case to worry about.
            tierRankSql = `CASE WHEN e.city_id = $2 THEN 1 ELSE 1 END`;
        }

        // Note: card city tier is based on the EVENT's city (where the plan is),
        // consistent with "females of my city" meaning events happening in my city.
        const feed = await pool.query(
            `SELECT
                t.id                AS ticket_id,
                t.user_id           AS person_id,
                p.first_name,
                EXTRACT(YEAR FROM AGE(p.date_of_birth))::INT AS age,
                p.gender,
                p.tagline,
                e.id                AS event_id,
                e.name              AS event_name,
                e.category_id,
                e.city_id           AS event_city_id,
                e.starts_at,
                e.venue_name,
                e.event_type,
                (SELECT COUNT(*) FROM tickets t2 WHERE t2.event_id = e.id) AS going_count,
                ${tierRankSql}      AS tier_rank
             FROM tickets t
             JOIN profiles p ON p.user_id = t.user_id
             JOIN events   e ON e.id      = t.event_id
             WHERE t.user_id <> $1              -- exclude the viewer's own cards
               AND e.starts_at > now()          -- upcoming events only
             ORDER BY tier_rank ASC,
                      e.starts_at ASC,          -- soonest event first
                      t.created_at DESC         -- newest ticket as tiebreak
             LIMIT 100`,
            [userId, viewerCity]
        );

        if (feed.rows.length === 0) {
            return res.json({ cards: [] });
        }

        // Fetch photos + tags for the people in the feed, in two batched queries
        // rather than N+1. Collect the person IDs first.
        const personIds = [...new Set(feed.rows.map(r => r.person_id))];

        const photos = await pool.query(
            `SELECT user_id, s3_key, position
             FROM profile_photos
             WHERE user_id = ANY($1::uuid[])
             ORDER BY position ASC`,
            [personIds]
        );

        const tags = await pool.query(
            `SELECT plt.user_id, lt.label, lt.category
             FROM profile_lifestyle_tags plt
             JOIN lifestyle_tags lt ON lt.id = plt.lifestyle_tag_id
             WHERE plt.user_id = ANY($1::uuid[])`,
            [personIds]
        );

        // Bucket is private — sign every key across every card in one batch,
        // not per-card. Signing is local crypto (no network call), so this
        // stays fast even at the 100-card cap.
        const viewUrls = await getPhotoViewUrls(photos.rows.map(row => row.s3_key));

        // Group photos and tags by person for quick lookup
        const photosByPerson = {};
        for (const row of photos.rows) {
            (photosByPerson[row.user_id] ??= []).push({ url: viewUrls[row.s3_key], position: row.position });
        }
        const tagsByPerson = {};
        for (const row of tags.rows) {
            (tagsByPerson[row.user_id] ??= []).push({ label: row.label, category: row.category });
        }

        const cards = feed.rows.map(r => ({
            ticketId: r.ticket_id,
            person: {
                id:            r.person_id,
                firstName:     r.first_name,
                age:           r.age,
                gender:        r.gender,
                tagline:       r.tagline,
                photos:        photosByPerson[r.person_id] ?? [],
                lifestyleTags: tagsByPerson[r.person_id] ?? []
            },
            event: {
                id:          r.event_id,
                name:        r.event_name,
                categoryId:  r.category_id,
                cityId:      r.event_city_id,
                startsAt:    r.starts_at,
                venueName:   r.venue_name,
                eventType:   r.event_type,
                goingCount:  parseInt(r.going_count, 10)
            }
        }));

        res.json({ cards });

    } catch (err) {
        console.error('GET /vibes error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default vibesRouter;