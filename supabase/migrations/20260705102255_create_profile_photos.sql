-- Profile photos table
-- 1:many — one user has 2-4 ordered photos
-- s3_key stores the S3 pointer only; image bytes never touch the DB
-- position 0 = "Main" photo; 0-3 captures full grid order in one column
-- UNIQUE(user_id, position) prevents two photos claiming the same slot
-- 2-4 count rule enforced in app logic, not DB constraints
CREATE TABLE profile_photos (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID         NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
    s3_key      TEXT         NOT NULL,                          -- e.g. "profiles/user-id/photo-1.jpg"
    position    SMALLINT     NOT NULL CHECK (position BETWEEN 0 AND 3),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

    UNIQUE (user_id, position)
);