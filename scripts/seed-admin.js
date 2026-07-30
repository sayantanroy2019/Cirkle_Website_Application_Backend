// One-time bootstrap script — creates the first 'administrative' admin.
// Admins are normally created by other administrative admins via
// POST /admin/admins, but the very first one has no creator. This script
// solves that bootstrap problem. It never runs in normal operation.
//
// Usage:
//   node scripts/seed-admin.js --email you@cirkle.live --password "..." --displayName "Your Name"
// Or edit the DEFAULT_* constants below and run with no args:
//   node scripts/seed-admin.js
//
// Idempotent — re-running with the same email does nothing if that admin
// already exists.

import bcrypt from 'bcrypt';
import { pool } from '../src/config/db.js';

// EDIT THESE if you're not passing --email/--password/--displayName flags.
const DEFAULT_EMAIL = 'founder@cirkle.live';
const DEFAULT_PASSWORD = 'change-this-before-running';
const DEFAULT_DISPLAY_NAME = 'Founder';

function readArg(flag, fallback) {
    const i = process.argv.indexOf(flag);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
    const email = readArg('--email', DEFAULT_EMAIL).trim().toLowerCase();
    const password = readArg('--password', DEFAULT_PASSWORD);
    const displayName = readArg('--displayName', DEFAULT_DISPLAY_NAME);

    const existing = await pool.query('SELECT id FROM admins WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
        console.log(`Admin ${email} already exists — nothing to do.`);
        await pool.end();
        return;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const inserted = await pool.query(
        `INSERT INTO admins (email, password_hash, display_name, role)
         VALUES ($1, $2, $3, 'administrative')
         RETURNING id, email, display_name, role`,
        [email, passwordHash, displayName]
    );

    console.log('Created first admin:', inserted.rows[0]);
    await pool.end();
}

main().catch(async (err) => {
    console.error('seed-admin failed:', err.message);
    await pool.end();
    process.exit(1);
});
