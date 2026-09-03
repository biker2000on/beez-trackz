-- +goose Up
-- Floral source as a declared claim on harvest lots, mating-yard fields on
-- queens, and no further mass-column rewrites (honey_weight_entered already
-- exists from 00026; this migration only adds the claim / mating columns).

-- One declared source shared by the lot, labels, and Honey Story.
-- Elevation is stored in meters (canonical); the client formats ft/m.
ALTER TABLE harvest_lots
  ADD COLUMN claim_species text,
  ADD COLUMN claim_year integer
    CHECK (claim_year IS NULL OR (claim_year >= 1900 AND claim_year <= 2100)),
  ADD COLUMN claim_apiary_id uuid REFERENCES apiaries(id) ON DELETE SET NULL,
  ADD COLUMN claim_elevation_m double precision
    CHECK (claim_elevation_m IS NULL OR (claim_elevation_m >= -500 AND claim_elevation_m <= 9000));

CREATE INDEX harvest_lots_claim_apiary_idx ON harvest_lots (claim_apiary_id)
  WHERE claim_apiary_id IS NOT NULL;

COMMENT ON COLUMN harvest_lots.claim_species IS
  'Declared floral source: species or free label (e.g. Sourwood). Shared by lot, label, and Honey Story.';
COMMENT ON COLUMN harvest_lots.claim_year IS
  'Harvest year of the declared floral source.';
COMMENT ON COLUMN harvest_lots.claim_apiary_id IS
  'Yard named on the floral claim (e.g. Yard B).';
COMMENT ON COLUMN harvest_lots.claim_elevation_m IS
  'Elevation of the claimed source in meters. Display converts to feet when the operator prefers US units.';

-- Where she mated, plus an optional free-text drone-source note.
-- Grafting cycle is out of scope (roadmap: skip until recorded as a note).
ALTER TABLE queens
  ADD COLUMN mated_at_apiary_id uuid REFERENCES apiaries(id) ON DELETE SET NULL,
  ADD COLUMN drone_source_note text;

CREATE INDEX queens_mated_at_apiary_idx ON queens (mated_at_apiary_id)
  WHERE mated_at_apiary_id IS NOT NULL;

COMMENT ON COLUMN queens.mated_at_apiary_id IS
  'Mating yard: the apiary where this queen mated.';
COMMENT ON COLUMN queens.drone_source_note IS
  'Optional free-text note on drone source (which yards were flooding drones).';

-- +goose Down
DROP INDEX IF EXISTS queens_mated_at_apiary_idx;
ALTER TABLE queens
  DROP COLUMN IF EXISTS drone_source_note,
  DROP COLUMN IF EXISTS mated_at_apiary_id;

DROP INDEX IF EXISTS harvest_lots_claim_apiary_idx;
ALTER TABLE harvest_lots
  DROP COLUMN IF EXISTS claim_elevation_m,
  DROP COLUMN IF EXISTS claim_apiary_id,
  DROP COLUMN IF EXISTS claim_year,
  DROP COLUMN IF EXISTS claim_species;
