import express from 'express';
import {pool} from '../config/db.js';
import authenticate from '../middlewares/auth.js';

const onboardingRouter = express.Router();

// GET /onboarding/status
// Returns the current onboarding step and gate flag for the logged-in user
// Frontend uses this to resume onboarding at the exact right step
onboardingRouter.get('/status', authenticate, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT current_onboarding_step, partial_profile_complete
             FROM users
             WHERE id = $1`,
            [req.user.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = result.rows[0];

        res.json({
            currentOnboardingStep: user.current_onboarding_step,
            partialProfileComplete: user.partial_profile_complete
        });

    } catch (err) {
        console.error('GET /onboarding/status error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /onboarding/step/1
// Saves first name and last name
// Updates current_onboarding_step to 1 if not already further ahead
onboardingRouter.patch('/step/1', authenticate, async (req, res) => {
    const { firstName, lastName } = req.body;

    if (!firstName || !lastName) {
        return res.status(400).json({ error: 'First name and last name are required' });
    }

    if (firstName.trim().length < 1 || lastName.trim().length < 1) {
        return res.status(400).json({ error: 'Names must be at least 1 characters' });
    }

    try {
        await pool.query(
            `UPDATE profiles
             SET first_name = $1,
                 last_name  = $2,
                 updated_at = now()
             WHERE user_id = $3`,
            [firstName.trim(), lastName.trim(), req.user.userId]
        );

        await pool.query(
            `UPDATE users
             SET current_onboarding_step = GREATEST(current_onboarding_step, 1),
                 updated_at = now()
             WHERE id = $1`,
            [req.user.userId]
        );

        res.json({ success: true, currentOnboardingStep: 1 });

    } catch (err) {
        console.error('PATCH /onboarding/step/1 error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// PATCH /onboarding/step/2
// Saves date of birth — no age restriction
// DOB stored as DATE, never returned by any API — age is derived on read
onboardingRouter.patch('/step/2', authenticate, async (req, res) => {
    const { dateOfBirth } = req.body;

    if (!dateOfBirth) {
        return res.status(400).json({ error: 'Date of birth is required' });
    }

    const dob = new Date(dateOfBirth);

    if (isNaN(dob.getTime())) {
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    try {
        await pool.query(
            `UPDATE profiles
             SET date_of_birth = $1,
                 updated_at    = now()
             WHERE user_id = $2`,
            [dateOfBirth, req.user.userId]
        );

        await pool.query(
            `UPDATE users
             SET current_onboarding_step = GREATEST(current_onboarding_step, 2),
                 updated_at = now()
             WHERE id = $1`,
            [req.user.userId]
        );

        res.json({ success: true, currentOnboardingStep: 2 });

    } catch (err) {
        console.error('PATCH /onboarding/step/2 error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /onboarding/step/3
// Saves gender
// Must be one of the four allowed values — matches DB CHECK constraint
onboardingRouter.patch('/step/3', authenticate, async (req, res) => {
    const { gender } = req.body;

    const allowed = ['man', 'woman', 'non_binary', 'prefer_not_to_say'];

    if (!gender || !allowed.includes(gender)) {
        return res.status(400).json({
            error: `Gender must be one of: ${allowed.join(', ')}`
        });
    }

    try {
        await pool.query(
            `UPDATE profiles
             SET gender     = $1,
                 updated_at = now()
             WHERE user_id = $2`,
            [gender, req.user.userId]
        );

        await pool.query(
            `UPDATE users
             SET current_onboarding_step = GREATEST(current_onboarding_step, 3),
                 updated_at = now()
             WHERE id = $1`,
            [req.user.userId]
        );

        res.json({ success: true, currentOnboardingStep: 3 });

    } catch (err) {
        console.error('PATCH /onboarding/step/3 error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /onboarding/step/4
// Saves city selection
// Validates city_id exists in the cities table — keeps app in sync with DB
onboardingRouter.patch('/step/4', authenticate, async (req, res) => {
    const { cityId } = req.body;

    if (!cityId) {
        return res.status(400).json({ error: 'City is required' });
    }

    try {
        // Validate city exists in DB — don't hardcode the list in app code
        const cityCheck = await pool.query(
            'SELECT id FROM cities WHERE id = $1',
            [cityId]
        );

        if (cityCheck.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid city' });
        }

        await pool.query(
            `UPDATE profiles
             SET city_id    = $1,
                 updated_at = now()
             WHERE user_id = $2`,
            [cityId, req.user.userId]
        );

        await pool.query(
            `UPDATE users
             SET current_onboarding_step = GREATEST(current_onboarding_step, 4),
                 updated_at = now()
             WHERE id = $1`,
            [req.user.userId]
        );

        res.json({ success: true, currentOnboardingStep: 4 });

    } catch (err) {
        console.error('PATCH /onboarding/step/4 error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /onboarding/step/5
// Saves lifestyle tag selections
// Replaces all existing tags for this user — clean slate on every save
// Min 3, max 5 tags enforced in app logic (can't be done as a DB constraint)
onboardingRouter.patch('/step/5', authenticate, async (req, res) => {
    const { lifestyleTagIds } = req.body;

    if (!Array.isArray(lifestyleTagIds) || lifestyleTagIds.length < 3 || lifestyleTagIds.length > 5) {
        return res.status(400).json({ error: 'Select between 3 and 5 lifestyle tags' });
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!lifestyleTagIds.every(id => uuidRegex.test(id))) {
        return res.status(400).json({ error: 'One or more invalid lifestyle tags' });
    }

    const client = await pool.connect();

    try {
        // Validate all tag IDs exist in the lifestyle_tags table
        const tagCheck = await client.query(
            'SELECT id FROM lifestyle_tags WHERE id = ANY($1::uuid[])',
            [lifestyleTagIds]
        );

        if (tagCheck.rows.length !== lifestyleTagIds.length) {
            return res.status(400).json({ error: 'One or more invalid lifestyle tags' });
        }

        // Transaction: delete existing tags + insert new ones atomically
        await client.query('BEGIN');

        await client.query(
            'DELETE FROM profile_lifestyle_tags WHERE user_id = $1',
            [req.user.userId]
        );

        for (const tagId of lifestyleTagIds) {
            await client.query(
                `INSERT INTO profile_lifestyle_tags (user_id, lifestyle_tag_id)
                 VALUES ($1, $2)`,
                [req.user.userId, tagId]
            );
        }

        await client.query('COMMIT');

        await pool.query(
            `UPDATE users
             SET current_onboarding_step = GREATEST(current_onboarding_step, 5),
                 updated_at = now()
             WHERE id = $1`,
            [req.user.userId]
        );

        res.json({ success: true, currentOnboardingStep: 5 });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('PATCH /onboarding/step/5 error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// PATCH /onboarding/step/6
// Saves profile photos
// STUBBED: accepts s3Key strings directly — no real S3 upload yet
// Real flow (pre-launch): client gets presigned URL → uploads to S3 →
// sends s3Key back here → server verifies via HeadObject → saves
// Min 2, max 4 photos. Position 0 = Main photo (required).
onboardingRouter.patch('/step/6', authenticate, async (req, res) => {
    const { photos } = req.body;

    if (!Array.isArray(photos) || photos.length < 2 || photos.length > 4) {
        return res.status(400).json({ error: 'Upload between 2 and 4 photos' });
    }

    // Validate each photo has s3Key and valid position (0-3)
    const validPositions = [0, 1, 2, 3];
    for (const photo of photos) {
        if (!photo.s3Key) {
            return res.status(400).json({ error: 'Each photo must have an s3Key' });
        }
        if (!validPositions.includes(photo.position)) {
            return res.status(400).json({ error: 'Each photo must have a position between 0 and 3' });
        }
    }

    // Position 0 (Main photo) must always be present
    const hasMain = photos.some(p => p.position === 0);
    if (!hasMain) {
        return res.status(400).json({ error: 'A main photo (position 0) is required' });
    }

    // No duplicate positions
    const positions = photos.map(p => p.position);
    const uniquePositions = new Set(positions);
    if (uniquePositions.size !== positions.length) {
        return res.status(400).json({ error: 'Each photo must have a unique position' });
    }

    const client = await pool.connect();

    try {
        // Transaction: delete existing photos + insert new ones atomically
        await client.query('BEGIN');

        await client.query(
            'DELETE FROM profile_photos WHERE user_id = $1',
            [req.user.userId]
        );

        for (const photo of photos) {
            await client.query(
                `INSERT INTO profile_photos (user_id, s3_key, position)
                 VALUES ($1, $2, $3)`,
                [req.user.userId, photo.s3Key, photo.position]
            );
        }

        await client.query('COMMIT');

        await pool.query(
            `UPDATE users
             SET current_onboarding_step = GREATEST(current_onboarding_step, 6),
                 updated_at = now()
             WHERE id = $1`,
            [req.user.userId]
        );

        res.json({ success: true, currentOnboardingStep: 6 });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('PATCH /onboarding/step/6 error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

// PATCH /onboarding/step/7
// Saves email and completes onboarding
// Sets partial_profile_complete = true — this is the Feed access gate
// Email is NOT a login credential — phone is. Email is for ticket delivery only.
onboardingRouter.patch('/step/7', authenticate, async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }

    try {
        await pool.query(
            `UPDATE profiles
             SET email      = $1,
                 updated_at = now()
             WHERE user_id = $2`,
            [email.toLowerCase().trim(), req.user.userId]
        );

        // Advance step AND unlock Feed access in one query
        await pool.query(
            `UPDATE users
             SET current_onboarding_step  = GREATEST(current_onboarding_step, 7),
                 partial_profile_complete  = true,
                 updated_at               = now()
             WHERE id = $1`,
            [req.user.userId]
        );

        res.json({
            success: true,
            currentOnboardingStep: 7,
            partialProfileComplete: true
        });

    } catch (err) {
        console.error('PATCH /onboarding/step/7 error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default onboardingRouter;