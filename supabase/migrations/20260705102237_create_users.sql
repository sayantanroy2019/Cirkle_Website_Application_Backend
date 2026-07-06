-- Users table (auth + gate flags only)
-- Holds login credentials and onboarding progress tracking
-- Deliberately lean: no profile data here (lives in profiles table)
-- phone-as-password is a Phase 1 stub; replaced by OTP at final phase
CREATE TABLE users (
    id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    phone                     TEXT        NOT NULL UNIQUE,      -- "+919876543210" (with country code)
    password_hash             TEXT        NOT NULL,             -- bcrypt (phone-as-password stub)
    role                      TEXT        NOT NULL DEFAULT 'attendee' CHECK (role IN ('attendee','organizer','admin')),
    current_onboarding_step   SMALLINT    NOT NULL DEFAULT 0,   -- 0-7 resume pointer
    partial_profile_complete  BOOLEAN     NOT NULL DEFAULT false, -- Feed-access gate
    profile_complete          BOOLEAN     NOT NULL DEFAULT false,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);