-- +goose Up
-- Roadmap item 8: field-work and colony-health objects.

ALTER TABLE inspections
  ADD COLUMN frames_of_bees integer CHECK (frames_of_bees IS NULL OR frames_of_bees >= 0),
  ADD COLUMN frames_of_brood integer CHECK (frames_of_brood IS NULL OR frames_of_brood >= 0),
  ADD COLUMN frames_of_stores integer CHECK (frames_of_stores IS NULL OR frames_of_stores >= 0),
  ADD COLUMN crowded_brood boolean,
  ADD COLUMN queen_cups_count integer CHECK (queen_cups_count IS NULL OR queen_cups_count >= 0),
  ADD COLUMN queen_cells_count integer CHECK (queen_cells_count IS NULL OR queen_cells_count >= 0),
  ADD COLUMN flow_on boolean;

CREATE TABLE catch_boxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apiary_id uuid NOT NULL REFERENCES apiaries(id) ON DELETE CASCADE,
  location_kind text NOT NULL CHECK (location_kind IN ('yard', 'stand', 'fence_line')),
  stand_id text,
  fence_line text,
  date_set date NOT NULL,
  empty_as_of date,
  occupied boolean NOT NULL DEFAULT false,
  occupied_at date,
  occupied_hive_id uuid REFERENCES hives(id) ON DELETE SET NULL,
  notes text,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  deletion_reason text,
  CONSTRAINT catch_boxes_location_fields CHECK (
    (location_kind <> 'stand' OR stand_id IS NOT NULL) AND
    (location_kind <> 'fence_line' OR fence_line IS NOT NULL)
  ),
  CONSTRAINT catch_boxes_occupied_fields CHECK (
    (occupied = false AND occupied_at IS NULL AND occupied_hive_id IS NULL) OR
    (occupied = true AND occupied_at IS NOT NULL)
  )
);
CREATE INDEX catch_boxes_apiary_live_idx ON catch_boxes (apiary_id, date_set DESC)
  WHERE deleted_at IS NULL;
CREATE TRIGGER catch_boxes_updated_at BEFORE UPDATE ON catch_boxes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE colony_intakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL UNIQUE REFERENCES hives(id) ON DELETE RESTRICT,
  apiary_id uuid NOT NULL REFERENCES apiaries(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN ('package', 'nuc', 'split', 'swarm', 'catch_box', 'other')),
  source_detail text,
  source_hive_id uuid REFERENCES hives(id) ON DELETE SET NULL,
  catch_box_id uuid REFERENCES catch_boxes(id) ON DELETE SET NULL,
  intake_date date NOT NULL,
  starting_stores text,
  cost_cents bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  expense_id uuid NOT NULL UNIQUE REFERENCES expenses(id) ON DELETE RESTRICT,
  queen_id uuid REFERENCES queens(id) ON DELETE SET NULL,
  cohort_year integer NOT NULL CHECK (cohort_year BETWEEN 1900 AND 2200),
  notes text,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX colony_intakes_apiary_date_idx ON colony_intakes (apiary_id, intake_date DESC);
CREATE INDEX colony_intakes_cohort_idx ON colony_intakes (cohort_year, queen_id);
CREATE TRIGGER colony_intakes_updated_at BEFORE UPDATE ON colony_intakes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE field_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_type text NOT NULL CHECK (incident_type IN ('robbing', 'yellowjackets', 'bears', 'skunks', 'flood')),
  incident_date date NOT NULL,
  apiary_id uuid NOT NULL REFERENCES apiaries(id) ON DELETE CASCADE,
  hive_id uuid REFERENCES hives(id) ON DELETE CASCADE,
  notes text,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  deletion_reason text
);
CREATE INDEX field_incidents_apiary_date_live_idx
  ON field_incidents (apiary_id, incident_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX field_incidents_hive_date_live_idx
  ON field_incidents (hive_id, incident_date DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER field_incidents_updated_at BEFORE UPDATE ON field_incidents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE deadout_autopsies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL UNIQUE REFERENCES hives(id) ON DELETE CASCADE,
  autopsy_date date NOT NULL,
  stores_left text,
  cluster_position text,
  last_fall_mite_load numeric(8,2) CHECK (last_fall_mite_load IS NULL OR last_fall_mite_load >= 0),
  queen_status text CHECK (queen_status IS NULL OR queen_status IN ('present', 'absent', 'unknown')),
  moisture boolean,
  mold boolean,
  notes text,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deadout_autopsies_date_idx ON deadout_autopsies (autopsy_date DESC);
CREATE TRIGGER deadout_autopsies_updated_at BEFORE UPDATE ON deadout_autopsies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP VIEW equipment_stock_status;
ALTER TABLE equipment_stock
  ADD COLUMN first_deployed_year integer
    CHECK (first_deployed_year IS NULL OR first_deployed_year BETWEEN 1900 AND 2200);
CREATE VIEW equipment_stock_status AS
SELECT
  es.id AS stock_id,
  es.type_id,
  et.name AS type_name,
  et.category AS type_category,
  et.frames_per_box,
  es.total_owned,
  es.damaged_quantity,
  es.retired_quantity,
  es.needed_quantity,
  es.unit_cost_cents,
  es.frame_condition,
  es.storage_location,
  es.notes,
  es.first_deployed_year,
  es.created_at,
  es.updated_at,
  COALESCE(dep.deployed, 0) AS deployed,
  es.total_owned - es.damaged_quantity - es.retired_quantity
    - COALESCE(dep.deployed, 0) AS available
FROM equipment_stock es
JOIN equipment_types et ON et.id = es.type_id
LEFT JOIN (
  SELECT stock_id, SUM(quantity - quantity_returned)::int AS deployed
  FROM equipment_deployments
  GROUP BY stock_id
) dep ON dep.stock_id = es.id;

-- +goose Down
DROP VIEW equipment_stock_status;
ALTER TABLE equipment_stock DROP COLUMN first_deployed_year;
CREATE VIEW equipment_stock_status AS
SELECT
  es.id AS stock_id, es.type_id, et.name AS type_name, et.category AS type_category,
  et.frames_per_box, es.total_owned, es.damaged_quantity, es.retired_quantity,
  es.needed_quantity, es.unit_cost_cents, es.frame_condition, es.storage_location,
  es.notes, es.created_at, es.updated_at, COALESCE(dep.deployed, 0) AS deployed,
  es.total_owned - es.damaged_quantity - es.retired_quantity
    - COALESCE(dep.deployed, 0) AS available
FROM equipment_stock es
JOIN equipment_types et ON et.id = es.type_id
LEFT JOIN (
  SELECT stock_id, SUM(quantity - quantity_returned)::int AS deployed
  FROM equipment_deployments GROUP BY stock_id
) dep ON dep.stock_id = es.id;

DROP TABLE deadout_autopsies;
DROP TABLE field_incidents;
DROP TABLE colony_intakes;
DROP TABLE catch_boxes;
ALTER TABLE inspections
  DROP COLUMN flow_on,
  DROP COLUMN queen_cells_count,
  DROP COLUMN queen_cups_count,
  DROP COLUMN crowded_brood,
  DROP COLUMN frames_of_stores,
  DROP COLUMN frames_of_brood,
  DROP COLUMN frames_of_bees;
