-- +goose Up
ALTER TABLE hives ADD COLUMN gps_source text;

ALTER TABLE hives
  ADD CONSTRAINT hives_gps_source_check
  CHECK (gps_source IS NULL OR gps_source IN ('layout', 'manual'));

-- +goose Down
ALTER TABLE hives DROP CONSTRAINT IF EXISTS hives_gps_source_check;
ALTER TABLE hives DROP COLUMN IF EXISTS gps_source;
