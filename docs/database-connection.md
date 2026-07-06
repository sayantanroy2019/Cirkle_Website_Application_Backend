# Connecting the backend to Supabase Postgres

This documents how the Express backend connects to the project's Supabase
Postgres database directly via `pg`, rather than through the Supabase JS SDK.

## Why direct Postgres instead of the Supabase client

The Supabase JS SDK (`@supabase/supabase-js`) talks to Postgres through
PostgREST (an auto-generated REST API in front of the database). Since we're
building our own Express API layer and want full control over SQL, we connect
straight to Postgres using the [`pg`](https://node-postgres.com/) driver
instead.

## 1. Get the connection string

Supabase Dashboard → **Connect** button (top bar) → **Direct connection
string** tab → choose a pooler mode.

Three options are offered:

| Mode | Port | Use case |
|---|---|---|
| Direct connection | 5432 | Only works with IPv6 or the paid IPv4 add-on |
| Transaction pooler | 6543 | Serverless/edge functions; no prepared statement support |
| **Session pooler** | 5432 | Persistent servers (our case) — behaves like a normal Postgres connection, supports prepared statements, works over IPv4 |

We use **Session pooler**.

## 2. Fix up the copied string

The dashboard shows the password as a bracketed placeholder, e.g.
`[YOUR-PASSWORD]`. Two things need fixing before it will work:

1. **Remove the brackets** — they're just placeholder formatting, not part of
   the real password.
2. **Percent-encode special characters** in the password (e.g. `!` → `%21`,
   `+` → `%2B`) so the URL parses correctly.

Result looks like:

```
postgresql://postgres.<project-ref>:<url-encoded-password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

## 3. Store it in `.env`

```bash
# .env
DATABASE_URL=postgresql://postgres.xxxx:...@aws-0-....pooler.supabase.com:5432/postgres
PORT=3000
```

`.env` is gitignored; `.env.example` documents the required keys without
real values.

## 4. Code wiring

- **[`src/config/env.js`](../src/config/env.js)** — loads env vars via
  `dotenv`, throws at startup if `DATABASE_URL` is missing.
- **[`src/config/db.js`](../src/config/db.js)** — creates a single shared
  `pg` `Pool` using `config.databaseUrl`. `ssl: { rejectUnauthorized: false }`
  is required because Supabase's pooler uses a certificate not in Node's
  default trust store; the connection is still encrypted, only strict chain
  verification is relaxed.
- **[`src/app.js`](../src/app.js)** — imports the pool and exposes
  `GET /health/db`, which runs `SELECT NOW()` to confirm connectivity.

Route handlers should import `{ pool }` from `src/config/db.js` and call
`pool.query(...)` — never create a new `Pool` per request.

## 5. Verifying the connection

```bash
npm run dev
curl http://localhost:3000/health/db
# {"status":"ok","now":"2026-07-06T07:49:07.926Z"}
```

An error response there almost always means the connection string is
malformed (leftover brackets, unencoded special characters, or wrong pooler
port).
