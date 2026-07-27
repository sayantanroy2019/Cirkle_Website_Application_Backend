import express from 'express';
import authenticate from '../middlewares/auth.js';
import { createProfilePhotoUploadUrl } from '../utils/s3.js';

const uploadsRouter = express.Router();

// POST /uploads/profile-photo-url
// Issues a presigned PUT URL for one profile photo upload.
// The client uploads the file DIRECTLY to S3 using the returned url, then
// sends the returned key to the profile/onboarding endpoint to save it.
//
// Body: { contentType: 'image/jpeg' | 'image/png' | 'image/webp' }
uploadsRouter.post('/profile-photo-url', authenticate, async (req, res) => {
    const { contentType } = req.body;

    if (!contentType) {
        return res.status(400).json({ error: 'contentType is required' });
    }

    try {
        const { uploadUrl, key } = await createProfilePhotoUploadUrl(
            req.user.userId,
            contentType
        );
        res.json({ uploadUrl, key });

    } catch (err) {
        if (err.message === 'UNSUPPORTED_TYPE') {
            return res.status(400).json({ error: 'Only JPEG, PNG, and WebP images are allowed' });
        }
        console.error('POST /uploads/profile-photo-url error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default uploadsRouter;