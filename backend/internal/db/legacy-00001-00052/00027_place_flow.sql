-- +goose Up
-- Roadmap "P1 — Place and flow": elevation-banded bloom, a forage radius on
-- the pin, and CSV-ingested yard scales. Sits on the yard-map pin and
-- elevation_m delivered by 00018.

-- Elevation-banded flora. The band is a filter on bloom, not a species model:
-- every observation carries the ground elevation it was seen at, and the band
-- is derived from it so a band can never drift out of sync with the metres.
-- Bands (metres above sea level, matching the Appalachian flow the operator
-- works): valley <300, foothill 300–699, midslope 700–1099, ridge 1100–1599,
-- summit >=1600.
ALTER TABLE bloom_observations
  ADD COLUMN elevation_m double precision
    CHECK (elevation_m IS NULL OR (elevation_m >= -500 AND elevation_m <= 9000)),
  ADD COLUMN elevation_band text GENERATED ALWAYS AS (
    CASE
      WHEN elevation_m IS NULL THEN NULL
      WHEN elevation_m < 300 THEN 'valley'
      WHEN elevation_m < 700 THEN 'foothill'
      WHEN elevation_m < 1100 THEN 'midslope'
      WHEN elevation_m < 1600 THEN 'ridge'
      ELSE 'summit'
    END
  ) STORED;

-- Existing rows inherit the pin they were recorded at. A yard with no pin
-- elevation stays null: no band is better than an invented one.
UPDATE bloom_observations observation
SET elevation_m = apiary.elevation_m
FROM apiaries apiary
WHERE apiary.id = observation.apiary_id
  AND apiary.elevation_m IS NOT NULL;

CREATE INDEX bloom_observations_band_species_idx
  ON bloom_observations (elevation_band, species, year DESC);

-- Forage radius around the pin. Drawn on the Leaflet map, and the search
-- radius the Immich yard-timeline scan reads. 2.5 km is the working default
-- for a yard; the bound keeps it a forage circle, not a county.
ALTER TABLE apiaries
  ADD COLUMN forage_radius_m integer NOT NULL DEFAULT 2500
    CHECK (forage_radius_m BETWEEN 250 AND 8000);

-- Scale hives. One scale per yard is enough, so the hive link is optional.
-- CSV ingest only (Broodminder / HiveTracks exports); no MQTT.
CREATE TABLE yard_scales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apiary_id uuid NOT NULL REFERENCES apiaries(id) ON DELETE CASCADE,
  hive_id uuid REFERENCES hives(id) ON DELETE SET NULL,
  name text NOT NULL,
  vendor text NOT NULL DEFAULT 'other'
    CHECK (vendor IN ('broodminder', 'hivetracks', 'other')),
  device_id text,
  notes text,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (apiary_id, name)
);
CREATE INDEX yard_scales_apiary_idx ON yard_scales (apiary_id, name);
CREATE TRIGGER yard_scales_updated_at BEFORE UPDATE ON yard_scales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per scale per day. Sub-daily CSV rows collapse into the day's mean
-- plus its min/max so a gain/loss curve and a robbing spike both survive.
-- Weight is canonical pounds, like every other mass in the ledger; the CSV's
-- kg columns convert at ingest.
CREATE TABLE scale_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scale_id uuid NOT NULL REFERENCES yard_scales(id) ON DELETE CASCADE,
  reading_date date NOT NULL,
  weight_lb numeric(9,3) NOT NULL,
  weight_min_lb numeric(9,3),
  weight_max_lb numeric(9,3),
  temperature_f numeric(6,2),
  humidity_pct numeric(5,2) CHECK (humidity_pct IS NULL OR humidity_pct BETWEEN 0 AND 100),
  sample_count integer NOT NULL DEFAULT 1 CHECK (sample_count > 0),
  source_file text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scale_id, reading_date)
);
CREATE INDEX scale_readings_scale_date_idx
  ON scale_readings (scale_id, reading_date DESC);

-- +goose Down
DROP TABLE scale_readings;
DROP TABLE yard_scales;
ALTER TABLE apiaries DROP COLUMN forage_radius_m;
DROP INDEX bloom_observations_band_species_idx;
ALTER TABLE bloom_observations
  DROP COLUMN elevation_band,
  DROP COLUMN elevation_m;
