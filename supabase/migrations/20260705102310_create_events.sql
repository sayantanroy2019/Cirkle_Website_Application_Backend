-- Events table
-- Core dynamic entity: the city-filtered feed is the primary read path
-- price stored in paise (INTEGER): ₹500 = 50000; exact, matches Razorpay
-- starts_at NOT NULL; ends_at nullable (single-evening events leave empty,
-- multi-day trips fill it)
-- target_group_size included now (intrinsic event property, no table dep)
-- organizer_id deliberately deferred (organizers table doesn't exist yet;
-- Phase 1 seeds events manually)
CREATE TABLE events (
    id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name               TEXT         NOT NULL,
    category_id        TEXT         NOT NULL REFERENCES event_categories(id),
    city_id            TEXT         NOT NULL REFERENCES cities(id),
    starts_at          TIMESTAMPTZ  NOT NULL,
    ends_at            TIMESTAMPTZ,                        -- nullable: trips fill it, single-evening events don't
    price              INTEGER      NOT NULL,              -- paise (₹500 = 50000)
    target_group_size  INTEGER      NOT NULL,              -- drives discount-unlock mechanic
    venue_name         TEXT,
    venue_address      TEXT,
    description        TEXT,                               -- "About" section on Event Detail
    banner_s3_key      TEXT,                               -- S3 pointer; nullable pre-art
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);