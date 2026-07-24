-- Global application configuration (key/value)
-- Values stored as TEXT and cast in application code:
--   gst_percentage        -> parseFloat
--   hold_duration_minutes -> parseInt
-- Validation lives in the app layer (and later the admin panel form),
-- not in DB constraints — same permissive-DB philosophy used throughout.
-- updated_at earns its place here: "when did the GST rate last change?"
-- is a real reconciliation question.
CREATE TABLE app_settings (
    key          TEXT         PRIMARY KEY,       -- e.g. "gst_percentage"
    value        TEXT         NOT NULL,
    description  TEXT,                            -- human-readable label for the admin panel
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Seed the two settings the ticketing system reads
INSERT INTO app_settings (key, value, description) VALUES
    ('gst_percentage',        '18.00', 'GST percentage applied to all ticket orders'),
    ('hold_duration_minutes', '10',    'How long a checkout hold reserves a seat before expiring')
ON CONFLICT (key) DO NOTHING;