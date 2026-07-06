import pg from 'pg';
import { config } from './env.js';

const { Pool } = pg;

// Supabase pooler requires TLS but uses a certificate not in Node's default
// trust store, so we disable strict verification here (safe: traffic is
// still encrypted, only the certificate chain check is relaxed).
export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});
