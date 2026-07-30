-- Admin accounts — internal staff, separate identity space from attendees.
-- email/password auth (not phone/OTP like users) — admins are internal,
-- not the consumer-facing login flow.
--
-- Role has exactly two values. The only capability difference between them
-- is managing admin accounts (see src/utils/permissions.js) — everything
-- else both roles can do. Keep it that simple; don't add more roles here
-- without updating the permission map.
CREATE TABLE admins (
    id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    email          TEXT         NOT NULL UNIQUE,        -- login credential, stored lowercase
    password_hash  TEXT         NOT NULL,               -- bcrypt
    display_name   TEXT         NOT NULL,
    role           TEXT         NOT NULL DEFAULT 'business_development'
                                CHECK (role IN ('administrative','business_development')),
    is_active      BOOLEAN      NOT NULL DEFAULT true,  -- kill switch, disable without deleting
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
