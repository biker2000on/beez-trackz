-- +goose Up
-- Exact GPS on each hive, derived from its stand slot when the yard is
-- mapped. Apiary lat/lng stays the yard centroid.

ALTER TABLE hives
  ADD COLUMN latitude double precision,
  ADD COLUMN longitude double precision;
CREATE INDEX hives_gps_idx ON hives (latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS hives_gps_idx;
ALTER TABLE hives
  DROP COLUMN IF EXISTS latitude,
  DROP COLUMN IF EXISTS longitude;
