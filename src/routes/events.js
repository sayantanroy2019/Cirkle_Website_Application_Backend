import express from 'express';
import {pool}    from '../config/db.js';
import authenticate from '../middlewares/auth.js';

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
                bannerS3Key:     e.banner_s3_key
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
eventsRouter.get('/:id', authenticate, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
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
             WHERE id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        const e = result.rows[0];

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
                bannerS3Key:     e.banner_s3_key
            }
        });

    } catch (err) {
        console.error('GET /events/:id error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default eventsRouter;