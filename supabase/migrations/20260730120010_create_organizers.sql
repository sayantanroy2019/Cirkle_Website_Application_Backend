-- Organizer accounts — the business/promoter side, separate identity space
-- from attendees and admins. email/password auth, admin-created (no public
-- signup in this phase).
--
-- Financial fields (GSTIN, bank details, PAN, commission rate) deliberately
-- deferred until payout logic exists. Do not add them speculatively —
-- they'll land with the feature that actually needs them.
CREATE TABLE organizers (
    id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    email          TEXT         NOT NULL UNIQUE,        -- login credential, stored lowercase
    password_hash  TEXT         NOT NULL,               -- bcrypt
    display_name   TEXT         NOT NULL,               -- business name shown in dashboard
    is_active      BOOLEAN      NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
