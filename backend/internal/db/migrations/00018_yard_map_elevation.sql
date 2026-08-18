-- +goose Up
-- Ground elevation for the apiary pin (meters above sea level). Nullable on
-- purpose: do not invent 0. Source records how the value was filled so a
-- later flora-band view can tell GPS, terrain lookup, and operator override
-- apart. Solar altitude is a different quantity and is never stored here.

ALTER TABLE apiaries
  ADD COLUMN elevation_m double precision,
  ADD COLUMN elevation_source text;

ALTER TABLE apiaries
  ADD CONSTRAINT apiaries_elevation_source_check
  CHECK (
    elevation_source IS NULL
    OR elevation_source IN ('geolocation', 'terrain', 'override')
  );

ALTER TABLE apiaries
  ADD CONSTRAINT apiaries_elevation_pair_check
  CHECK (
    (elevation_m IS NULL AND elevation_source IS NULL)
    OR (elevation_m IS NOT NULL AND elevation_source IS NOT NULL)
  );

-- +goose Down
ALTER TABLE apiaries DROP CONSTRAINT IF EXISTS apiaries_elevation_pair_check;
ALTER TABLE apiaries DROP CONSTRAINT IF EXISTS apiaries_elevation_source_check;
ALTER TABLE apiaries DROP COLUMN IF EXISTS elevation_source;
ALTER TABLE apiaries DROP COLUMN IF EXISTS elevation_m;
