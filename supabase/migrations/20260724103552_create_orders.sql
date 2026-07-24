-- Purchase attempt: seat hold + frozen price breakdown + Razorpay linkage
-- This table carries ALL the uncertainty (pending, failed, abandoned).
-- The tickets table stays pure: a row there means someone paid.
--
-- Price breakdown is FROZEN at order creation, never recomputed. This row is
-- a financial record — it must show what was actually charged, not what a
-- later recomputation thinks was charged. That's why subtotal_paise and
-- gst_paise are stored even though they're derivable.
--
-- gst_percentage is a SNAPSHOT: app_settings says what the rate is today,
-- this column says what it was when this order was charged.
CREATE TABLE orders (
    id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id              UUID         NOT NULL REFERENCES events(id) ON DELETE CASCADE,

    status                TEXT         NOT NULL DEFAULT 'created'
                                       CHECK (status IN ('created','paid','failed','expired','refunded')),

    -- Price breakdown (all paise). GST computed on POST-discount subtotal.
    base_price_paise      INTEGER      NOT NULL CHECK (base_price_paise >= 0),
    coupon_id             UUID         REFERENCES coupons(id),  -- no CASCADE: never erase a coupon with financial history
    discount_paise        INTEGER      NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),  -- clamped to base_price
    subtotal_paise        INTEGER      NOT NULL CHECK (subtotal_paise >= 0),            -- base - discount
    gst_percentage        NUMERIC(5,2) NOT NULL,                                        -- rate snapshot
    gst_paise             INTEGER      NOT NULL CHECK (gst_paise >= 0),                 -- computed on subtotal
    total_paise           INTEGER      NOT NULL CHECK (total_paise >= 0),               -- what Razorpay charged

    -- Razorpay linkage
    razorpay_order_id     TEXT         NOT NULL UNIQUE,  -- webhook idempotency lookup key
    razorpay_payment_id   TEXT,                          -- set on success
    razorpay_signature    TEXT,                          -- retained for audit
    payment_method        TEXT,   -- 'upi' | 'card' | 'netbanking' | 'wallet' | 'emi'
    payment_method_detail TEXT,   -- 'Visa 4242' | 'HDFC Bank' | 'PhonePe'

    -- Seat hold: availability counts rows WHERE status='created' AND expires_at > now()
    -- An expired hold stops counting automatically — no cleanup job required
    expires_at            TIMESTAMPTZ  NOT NULL,

    created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- One live hold per user per event.
-- Partial index: only applies to status='created', so failed/expired orders
-- never block a retry. Kills the double-tap problem at the DB level.
CREATE UNIQUE INDEX orders_one_live_hold_idx
    ON orders (user_id, event_id)
    WHERE status = 'created';

-- Serves the availability query on every order creation
CREATE INDEX orders_event_status_expires_idx
    ON orders (event_id, status, expires_at);