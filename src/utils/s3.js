import { PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import s3, { S3_BUCKET } from '../config/s3.js';

// How long a presigned URL stays valid
const UPLOAD_URL_TTL = 300;  // 5 min  — user picks a photo and uploads
const VIEW_URL_TTL   = 3600; // 1 hour — long enough for a browsing session

// Only these image types may be uploaded. The content type is baked into the
// signed URL, so the client MUST send a matching Content-Type or S3 rejects it.
const ALLOWED_TYPES = {
    'image/jpeg': 'jpg',
    'image/png':  'png',
    'image/webp': 'webp'
};

/**
 * Generates a presigned PUT URL for a profile photo upload.
 * The key is server-generated — the client never chooses where the file lands,
 * which prevents one user overwriting another's photos by crafting a key.
 *
 * @returns {{ uploadUrl, key }} the URL to PUT to, and the key to store later
 */
export async function createProfilePhotoUploadUrl(userId, contentType) {
    const ext = ALLOWED_TYPES[contentType];
    if (!ext) {
        throw new Error('UNSUPPORTED_TYPE');
    }

    // profiles/{userId}/{uuid}.{ext} — namespaced per user, collision-proof
    const key = `profiles/${userId}/${randomUUID()}.${ext}`;

    const command = new PutObjectCommand({
        Bucket:      S3_BUCKET,
        Key:         key,
        ContentType: contentType
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: UPLOAD_URL_TTL });
    return { uploadUrl, key };
}

/**
 * Generates a presigned PUT URL for an event image (banner or gallery).
 * Same server-generated-key pattern as profile photos — the client never
 * chooses where the file lands.
 *
 * @param {string} eventId
 * @param {'banner'|'gallery'} kind
 * @param {string} contentType
 * @returns {{ uploadUrl, key }} the URL to PUT to, and the key to store later
 */
export async function createEventImageUploadUrl(eventId, kind, contentType) {
    const ext = ALLOWED_TYPES[contentType];
    if (!ext) {
        throw new Error('UNSUPPORTED_TYPE');
    }

    // events/{eventId}/{kind}/{uuid}.{ext} — namespaced per event and kind
    const key = `events/${eventId}/${kind}/${randomUUID()}.${ext}`;

    const command = new PutObjectCommand({
        Bucket:      S3_BUCKET,
        Key:         key,
        ContentType: contentType
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: UPLOAD_URL_TTL });
    return { uploadUrl, key };
}

/**
 * Verifies an object actually exists in the bucket.
 * Called before saving a key to the DB — the client claims "I uploaded it,"
 * and this confirms the file genuinely landed rather than trusting the client.
 *
 * @returns {boolean}
 */
export async function objectExists(key) {
    try {
        await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
        return true;
    } catch (err) {
        // This IAM identity has no s3:ListBucket permission, so S3 returns 403
        // (not 404) for HeadObject on a key that genuinely doesn't exist —
        // documented AWS behavior, meant to avoid leaking object existence to
        // callers who can't list the bucket. Real objects HEAD fine with 200,
        // so a 403/AccessDenied here means "not found," not "forbidden."
        if (
            err.name === 'NotFound' ||
            err.name === 'AccessDenied' ||
            err.$metadata?.httpStatusCode === 404 ||
            err.$metadata?.httpStatusCode === 403
        ) {
            return false;
        }
        throw err; // a real error (network, wrong bucket, etc.) — don't swallow it
    }
}

/**
 * Generates a presigned GET URL so a private object can be displayed.
 * Short-lived — the URL works for VIEW_URL_TTL, then stops. This is what
 * gets sent to the frontend in place of the raw s3Key wherever a photo shows.
 */
export async function getPhotoViewUrl(key) {
    const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
    return getSignedUrl(s3, command, { expiresIn: VIEW_URL_TTL });
}

/**
 * Batch version — signs many keys at once for the Vibes feed and profile.
 * Returns a map of key -> viewUrl. Signing is a local crypto operation (no
 * network call), so doing 100 is fast; this just tidies the call site.
 */
export async function getPhotoViewUrls(keys) {
    const unique = [...new Set(keys)];
    const entries = await Promise.all(
        unique.map(async key => [key, await getPhotoViewUrl(key)])
    );
    return Object.fromEntries(entries);
}