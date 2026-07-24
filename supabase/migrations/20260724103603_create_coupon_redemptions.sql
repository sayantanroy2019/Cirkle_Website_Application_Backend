-- Coupon usage ledger.
-- Rows are created ONLY on payment success — this table means "coupons
-- actually used," never "coupons someone had in a checkout screen."
-- That's why coupons has no redemption counter column: both usage limits
-- are enforced by counting rows here.
--
-- Order creation additionally counts live holds referencing the coupon, so a
-- limited code gets approximate reservation without leaking on abandonment.
--
-- Own UUID PK rather than a composite: this isn't a pure join table (it
-- carries order_id and the applied amount), and usage_limit_per_user can
-- exceed 1, which a composite PK on (coupon_id, user_id) would forbid.
CREATE TABLE coupon_redemptions (
    id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

    coupon_id               UUID         NOT NULL REFERENCES coupons(id),   -- no CASCADE: never erase a coupon with usage history
    user_id                 UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- UNIQUE is the webhook idempotency backstop. Razorpay retries deliveries;
    -- without this, one purchase could burn two uses of a limited coupon.
    order_id                UUID         NOT NULL UNIQUE REFERENCES orders(id),

    -- Denormalized from orders.discount_paise but immutable, and it makes
    -- campaign accounting a single SUM with no join.
    -- CHECK > 0: a zero-value redemption is meaningless — no discount, no row.
    discount_applied_paise  INTEGER      NOT NULL CHECK (discount_applied_paise > 0),

    -- created_at only. A redemption is a financial event, never edited —
    -- updated_at would be a column that lies about behavior.
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Enforces usage_limit_total: count all redemptions for a coupon
CREATE INDEX coupon_redemptions_coupon_id_idx ON coupon_redemptions (coupon_id);

-- Enforces usage_limit_per_user: count this user's redemptions of this coupon
CREATE INDEX coupon_redemptions_coupon_user_idx ON coupon_redemptions (coupon_id, user_id);