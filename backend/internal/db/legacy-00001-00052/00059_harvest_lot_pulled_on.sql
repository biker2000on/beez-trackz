-- +goose Up
-- The day the frames/supers were pulled from the yard. A lot already records
-- when the honey was extracted; the pull date is the anchor for everything
-- the lot dialog can derive from the season's records (claim year, the
-- bloom window, which harvests belong). Nullable: older lots never knew it.
-- Both chains run this same file.
ALTER TABLE harvest_lots ADD COLUMN pulled_on date;

-- +goose Down
ALTER TABLE harvest_lots DROP COLUMN pulled_on;
