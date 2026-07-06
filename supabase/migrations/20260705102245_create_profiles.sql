-- Profiles table (onboarding + profile data)
-- Strict 1:1 extension of users — user_id is BOTH primary key and FK
-- Structurally guarantees exactly one profile per user
-- All onboarding columns nullable at DB level: incremental per-step
-- saving means the row exists half-empty during onboarding;
-- completeness enforced by partial_profile_complete flag on users
CREATE TABLE profiles (
    user_id         UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    first_name      TEXT,                       -- onboarding step 1
    last_name       TEXT,                       -- onboarding step 1
    date_of_birth   DATE,                       -- onboarding step 2; age derived on read, DOB never returned by API
    gender          TEXT         CHECK (gender IN ('man','woman','non_binary','prefer_not_to_say')),
    city_id         TEXT         REFERENCES cities(id),  -- TEXT matches cities.id slug type
    email           TEXT,                       -- onboarding step 7; not a login credential
    bio             TEXT,                       -- optional; filled post-onboarding
    tagline         TEXT,                       -- optional; filled post-onboarding
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);