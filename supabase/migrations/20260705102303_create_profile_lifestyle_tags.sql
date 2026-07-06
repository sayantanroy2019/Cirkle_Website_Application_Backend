-- Profile lifestyle tags join table
-- Pure many-to-many: one user picks many tags, each tag picked by many users
-- Composite PK (user_id, lifestyle_tag_id) is the identity —
-- structurally guarantees a user cannot pick the same tag twice
-- No timestamps: join-table rows are immutable (inserted or deleted,
-- never updated) so updated_at would always lie about behavior
CREATE TABLE profile_lifestyle_tags (
    user_id           UUID   NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
    lifestyle_tag_id  UUID   NOT NULL REFERENCES lifestyle_tags(id) ON DELETE CASCADE,

    PRIMARY KEY (user_id, lifestyle_tag_id)
);