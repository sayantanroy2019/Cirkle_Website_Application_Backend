-- Event categories reference table
-- Fixed list powering the Events-tab filter chips and event type badges
-- TEXT slug primary key: readable, tiny, static, rides into ?category= queries
CREATE TABLE event_categories (
    id          TEXT         PRIMARY KEY,       -- "club","concert","trip","meetup"
    label       TEXT         NOT NULL,          -- "Clubs","Concerts","Trips","Meetups"
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);