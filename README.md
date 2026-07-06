# Cirkle — Backend

Backend APIs for the Cirkle attendee-side application. Cirkle is a social layer
on top of event ticketing (see [Cirkle_Specifications.md](./Cirkle_Specifications.md)).

## Stack

- **Node.js** + **Express** (ES modules)
- **Supabase** (Postgres) — schema lives in [`supabase/`](./supabase); connected
  directly via `pg` (see [docs/database-connection.md](./docs/database-connection.md))

## Getting started

```bash
npm install
cp .env.example .env   # then fill in DATABASE_URL, see docs/database-connection.md
npm run dev            # start with auto-reload (node --watch)
```

Server runs on `http://localhost:3000` by default.
Health checks: `GET /health` (server) and `GET /health/db` (database).

## Scripts

- `npm start` — run the server
- `npm run dev` — run with file watching

## Layout

```
src/
  server.js        # entry point — starts the HTTP server
  app.js           # Express app + middleware + routes
  config/
    env.js         # environment variable loading
    db.js          # pg Pool connected to Supabase Postgres
supabase/          # database migrations, seed, config
docs/              # documentation (e.g. database connection setup)
```
