-- Lifestyle tags reference table
-- Fixed list of interest tags shown on anchor cards and profiles
-- UUID primary key: tags are matched on internally (unlike cities)
-- UNIQUE on label prevents duplicate tag data corruption
CREATE TABLE lifestyle_tags (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    label       TEXT         NOT NULL UNIQUE,   -- e.g. "Clubbing", "Live music"
    category    TEXT         NOT NULL,           -- e.g. "Going out" (display-only grouping)
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
