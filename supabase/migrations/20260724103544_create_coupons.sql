-- Discount coupon definitions
-- Phase 1: Cirkle-issued only. Organizer-issued coupons deferred with the
-- rest of the organizer side (would add an organizer_id FK here).
--
-- Flat discounts only — no percentage type, so no discount_type column,
-- no max_discount cap, no min_order threshold.
--
-- UUID PK rather than the code itself: a coupon code is user-facing text
-- that may need editing (typo at creation, campaign rebrand). With the code
-- as PK, changing it would cascade through every redemption row. UUID keeps
-- identity stable while the code stays editable.
--
-- No redemption counter column. usage_limit_total is enforced by counting
-- rows in coupon_redemptions — one source of truth, can't drift.
CREATE TABLE coupons (
    id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    code                  TEXT         NOT NULL UNIQUE,    -- stored + compared uppercase (app-layer normalization)
    discount_flat_paise   INTEGER      NOT NULL CHECK (discount_flat_paise > 0),  -- ₹100 off = 10000

    valid_from            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    valid_until           TIMESTAMPTZ,                     -- NULL = no expiry

    usage_limit_total     INTEGER      CHECK (usage_limit_total IS NULL OR usage_limit_total > 0),  -- NULL = unlimited
    usage_limit_per_user  INTEGER      NOT NULL DEFAULT 1 CHECK (usage_limit_per_user > 0),

    event_id              UUID         REFERENCES events(id) ON DELETE SET NULL,
    is_active             BOOLEAN      NOT NULL DEFAULT true,  -- kill switch: disable a leaked code without losing history

    created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);