-- Cities reference table
-- Fixed list of Indian cities; seeded separately in seed.sql
-- TEXT slug primary key (deliberate exception to UUID rule):
-- readable, tiny, static, public, non-sensitive data
CREATE TABLE cities (
    id          TEXT         PRIMARY KEY,       -- e.g. "del", "mum"
    name        TEXT         NOT NULL,          -- e.g. "Delhi NCR", "Mumbai"
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);