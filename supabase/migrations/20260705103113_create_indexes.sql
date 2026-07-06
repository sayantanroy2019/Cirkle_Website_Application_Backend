-- Indexes for Phase 1 read paths
-- Postgres does not auto-index foreign keys; these are added explicitly
-- based on the known query patterns for the Phase 1 feed

-- profiles: city-based lookups (every profile fetch filters by city)
CREATE INDEX ON profiles(city_id);

-- events: the core feed query filters by city
CREATE INDEX ON events(city_id);

-- events: feed query + category filter chip combined
CREATE INDEX ON events(city_id, category_id);

-- profile_photos: fetching all photos for a user
CREATE INDEX ON profile_photos(user_id);

-- profile_lifestyle_tags: the composite PK already covers (user_id, lifestyle_tag_id)
-- add index on lifestyle_tag_id alone for future "who picked this tag" matching queries
CREATE INDEX ON profile_lifestyle_tags(lifestyle_tag_id);
