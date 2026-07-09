import express from 'express';
import {pool} from '../config/db.js';
import authenticate from '../middlewares/auth.js';

const profileRouter = express.Router();

// GET /profile/me
// Returns the logged-in user's complete profile
// DOB never returned — age derived on read via Postgres AGE()
// Three separate queries: profile, photos, tags — avoids JOIN row duplication
profileRouter.get('/me', authenticate, async (req, res) => {
    try {
        const profileResult = await pool.query(
            `SELECT
                p.first_name,
                p.last_name,
                EXTRACT(YEAR FROM AGE(p.date_of_birth))::INTEGER AS age,
                p.gender,
                p.city_id,
                p.email,
                p.bio,
                p.tagline
             FROM profiles p
             WHERE p.user_id = $1`,
            [req.user.userId]
        );

        if (profileResult.rows.length === 0) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        const profile = profileResult.rows[0];

        const photosResult = await pool.query(
            `SELECT id, s3_key, position
             FROM profile_photos
             WHERE user_id = $1
             ORDER BY position ASC`,
            [req.user.userId]
        );

        const tagsResult = await pool.query(
            `SELECT lt.id, lt.label, lt.category
             FROM lifestyle_tags lt
             JOIN profile_lifestyle_tags plt ON lt.id = plt.lifestyle_tag_id
             WHERE plt.user_id = $1
             ORDER BY lt.category`,
            [req.user.userId]
        );

        res.json({
            profile: {
                firstName:     profile.first_name,
                lastName:      profile.last_name,
                age:           profile.age,
                gender:        profile.gender,
                cityId:        profile.city_id,
                email:         profile.email,
                bio:           profile.bio,
                tagline:       profile.tagline,
                photos:        photosResult.rows.map(p => ({
                    id:       p.id,
                    s3Key:    p.s3_key,
                    position: p.position
                })),
                lifestyleTags: tagsResult.rows.map(t => ({
                    id:       t.id,
                    label:    t.label,
                    category: t.category
                }))
            }
        });

    } catch (err) {
        console.error('GET /profile/me error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /profile/me
// Partial update — only updates fields that are actually sent
// Gender is immutable once set
// FOR UPDATE lock prevents race conditions from simultaneous requests
// All updates wrapped in a transaction for consistency
profileRouter.patch('/me', authenticate, async (req, res) => {
    const {
        firstName, lastName, bio, tagline,
        gender, cityId, email,
        lifestyleTagIds, photos
    } = req.body;

    // ── Validations (before touching the DB) ──────────────────────────

    if (firstName !== undefined && firstName.trim().length < 2) {
        return res.status(400).json({ error: 'First name must be at least 2 characters' });
    }
    if (lastName !== undefined && lastName.trim().length < 2) {
        return res.status(400).json({ error: 'Last name must be at least 2 characters' });
    }

    const allowedGenders = ['man', 'woman', 'non_binary', 'prefer_not_to_say'];
    if (gender !== undefined) {
        if (!allowedGenders.includes(gender)) {
            return res.status(400).json({ error: 'Gender must be one of: man, woman, non_binary, prefer_not_to_say' });
        }

        // Gender is immutable once set — check current value before allowing update
        const genderCheck = await pool.query(
            'SELECT gender FROM profiles WHERE user_id = $1',
            [req.user.userId]
        );
        if (genderCheck.rows[0].gender !== null) {
            return res.status(400).json({ error: 'Gender cannot be changed once set' });
        }
    }

    if (email !== undefined) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
    }

    if (lifestyleTagIds !== undefined) {
        if (!Array.isArray(lifestyleTagIds) || lifestyleTagIds.length < 3 || lifestyleTagIds.length > 5) {
            return res.status(400).json({ error: 'Select between 3 and 5 lifestyle tags' });
        }
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!lifestyleTagIds.every(id => uuidRegex.test(id))) {
            return res.status(400).json({ error: 'One or more invalid lifestyle tags' });
        }
    }

    if (photos !== undefined) {
        if (!Array.isArray(photos) || photos.length < 2 || photos.length > 4) {
            return res.status(400).json({ error: 'Upload between 2 and 4 photos' });
        }
        for (const photo of photos) {
            if (!photo.s3Key) {
                return res.status(400).json({ error: 'Each photo must have an s3Key' });
            }
            if (![0, 1, 2, 3].includes(photo.position)) {
                return res.status(400).json({ error: 'Each photo must have a position between 0 and 3' });
            }
        }
        if (!photos.some(p => p.position === 0)) {
            return res.status(400).json({ error: 'A main photo (position 0) is required' });
        }
        const positions = photos.map(p => p.position);
        if (new Set(positions).size !== positions.length) {
            return res.status(400).json({ error: 'Each photo must have a unique position' });
        }
    }

    // City DB check before transaction
    if (cityId !== undefined) {
        const cityCheck = await pool.query(
            'SELECT id FROM cities WHERE id = $1',
            [cityId]
        );
        if (cityCheck.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid city' });
        }
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Lock the profile row for this transaction — prevents race conditions
        // from simultaneous requests by the same user
        await client.query(
            'SELECT user_id FROM profiles WHERE user_id = $1 FOR UPDATE',
            [req.user.userId]
        );

        // ── Profile fields (dynamic SET clause) ───────────────────────
        const profileUpdates = [];
        const profileValues = [];
        let paramCount = 1;

        if (firstName !== undefined) {
            profileUpdates.push(`first_name = $${paramCount++}`);
            profileValues.push(firstName.trim());
        }
        if (lastName !== undefined) {
            profileUpdates.push(`last_name = $${paramCount++}`);
            profileValues.push(lastName.trim());
        }
        if (bio !== undefined) {
            profileUpdates.push(`bio = $${paramCount++}`);
            profileValues.push(bio.trim());
        }
        if (tagline !== undefined) {
            profileUpdates.push(`tagline = $${paramCount++}`);
            profileValues.push(tagline.trim());
        }
        if (gender !== undefined) {
            profileUpdates.push(`gender = $${paramCount++}`);
            profileValues.push(gender);
        }
        if (cityId !== undefined) {
            profileUpdates.push(`city_id = $${paramCount++}`);
            profileValues.push(cityId);
        }
        if (email !== undefined) {
            profileUpdates.push(`email = $${paramCount++}`);
            profileValues.push(email.toLowerCase().trim());
        }

        if (profileUpdates.length > 0) {
            profileValues.push(req.user.userId);
            await client.query(
                `UPDATE profiles
                 SET ${profileUpdates.join(', ')}, updated_at = now()
                 WHERE user_id = $${paramCount}`,
                profileValues
            );
        }

        // ── Lifestyle tags (delete + reinsert) ────────────────────────
        if (lifestyleTagIds !== undefined) {
            const tagCheck = await client.query(
                'SELECT id FROM lifestyle_tags WHERE id = ANY($1::uuid[])',
                [lifestyleTagIds]
            );
            if (tagCheck.rows.length !== lifestyleTagIds.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'One or more invalid lifestyle tags' });
            }

            await client.query(
                'DELETE FROM profile_lifestyle_tags WHERE user_id = $1',
                [req.user.userId]
            );
            for (const tagId of lifestyleTagIds) {
                await client.query(
                    'INSERT INTO profile_lifestyle_tags (user_id, lifestyle_tag_id) VALUES ($1, $2)',
                    [req.user.userId, tagId]
                );
            }
        }

        // ── Photos (delete + reinsert) ─────────────────────────────────
        if (photos !== undefined) {
            await client.query(
                'DELETE FROM profile_photos WHERE user_id = $1',
                [req.user.userId]
            );
            for (const photo of photos) {
                await client.query(
                    'INSERT INTO profile_photos (user_id, s3_key, position) VALUES ($1, $2, $3)',
                    [req.user.userId, photo.s3Key, photo.position]
                );
            }
        }

        await client.query('COMMIT');

        res.json({ success: true });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('PATCH /profile/me error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

export default profileRouter;