-- +goose Up
-- Full schema for the Go rewrite. Mirrors the legacy drizzle schema closely so
-- existing data can be migrated, with fixes: timestamptz, FK indexes, missing
-- FKs, and an updated_at trigger. Media columns hold MinIO object keys.

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

-- Enums
CREATE TYPE hive_status AS ENUM ('active', 'dead', 'sold', 'combined');
CREATE TYPE hive_placement AS ENUM ('full', 'top', 'bottom', 'left', 'right');
CREATE TYPE queen_origin AS ENUM ('purchased', 'swarm', 'raised', 'walked', 'emergency_cell', 'unknown');
CREATE TYPE queen_status AS ENUM ('active', 'superseded', 'dead', 'missing');
CREATE TYPE feed_type AS ENUM ('sugar_syrup_1to1', 'sugar_syrup_2to1', 'dry_sugar', 'pollen_patty', 'fondant', 'other');
CREATE TYPE feeder_type AS ENUM ('entrance', 'top', 'frame', 'baggie', 'bucket', 'open', 'other');
CREATE TYPE quantity_unit AS ENUM ('lbs', 'oz', 'quarts', 'gallons');
CREATE TYPE media_owner_type AS ENUM ('hive', 'apiary', 'inspection');
CREATE TYPE transcription_status AS ENUM ('pending', 'processing', 'complete', 'failed');
CREATE TYPE recommendation_type AS ENUM ('inspection_due', 'treatment_reminder', 'equipment_needed', 'seasonal_prep', 'feeder_check');
CREATE TYPE split_type AS ENUM ('walk-away', 'vertical', 'nuc', 'cutdown', 'other');
CREATE TYPE equipment_category AS ENUM ('box', 'cover', 'bottom', 'accessory', 'frame', 'other');
CREATE TYPE stock_adjustment_reason AS ENUM ('purchased', 'built', 'discarded', 'broken', 'gifted', 'other');
CREATE TYPE frame_condition AS ENUM ('drawn', 'fresh');
CREATE TYPE honey_movement_kind AS ENUM ('jarring', 'bulk_use', 'loss', 'give_away', 'jar_adjustment');

-- Apiaries & placement
CREATE TABLE apiaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  latitude double precision,
  longitude double precision,
  notes text,
  canvas_layout jsonb,
  satellite_image_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER apiaries_updated_at BEFORE UPDATE ON apiaries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE hives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apiary_id uuid NOT NULL REFERENCES apiaries(id),
  position_label text NOT NULL,
  stand_id text,
  slot_row integer,
  slot_col integer,
  placement hive_placement DEFAULT 'full',
  facing_degrees integer DEFAULT 0,
  status hive_status NOT NULL DEFAULT 'active',
  installed_date timestamptz,
  is_archived boolean NOT NULL DEFAULT false,
  deadout_date timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hives_apiary_id_idx ON hives (apiary_id);
CREATE TRIGGER hives_updated_at BEFORE UPDATE ON hives FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE hive_location_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id),
  apiary_id uuid NOT NULL REFERENCES apiaries(id),
  position_label text NOT NULL,
  date_from timestamptz NOT NULL,
  date_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hive_location_history_hive_id_idx ON hive_location_history (hive_id);
CREATE INDEX hive_location_history_apiary_id_idx ON hive_location_history (apiary_id);

CREATE TABLE hive_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_hive_id uuid NOT NULL REFERENCES hives(id),
  child_hive_id uuid NOT NULL REFERENCES hives(id),
  split_date timestamptz NOT NULL,
  split_type split_type NOT NULL,
  frames_moved integer,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hive_splits_parent_hive_id_idx ON hive_splits (parent_hive_id);
CREATE INDEX hive_splits_child_hive_id_idx ON hive_splits (child_hive_id);

-- Queens
CREATE TABLE queens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid REFERENCES hives(id),
  origin queen_origin NOT NULL,
  origin_hive_id uuid REFERENCES hives(id),
  parent_queen_id uuid REFERENCES queens(id),
  introduced_date timestamptz,
  status queen_status NOT NULL DEFAULT 'active',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX queens_hive_id_idx ON queens (hive_id);
CREATE INDEX queens_parent_queen_id_idx ON queens (parent_queen_id);
CREATE TRIGGER queens_updated_at BEFORE UPDATE ON queens FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Inspections
CREATE TABLE inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id),
  date timestamptz NOT NULL,
  inspector_name text,
  queen_seen boolean,
  queen_health text,
  brood_pattern text,
  stores_honey integer,
  stores_pollen integer,
  temperament integer,
  pests jsonb,
  treatments jsonb,
  notes text,
  source_media jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inspections_hive_id_date_idx ON inspections (hive_id, date DESC);
CREATE TRIGGER inspections_updated_at BEFORE UPDATE ON inspections FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Feedings (append-only)
CREATE TABLE feedings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id),
  date_fed timestamptz NOT NULL,
  type feed_type NOT NULL,
  quantity double precision NOT NULL,
  quantity_unit quantity_unit NOT NULL,
  feeder_type feeder_type,
  date_empty timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedings_hive_id_idx ON feedings (hive_id);

-- Harvest & sales
CREATE TABLE harvest_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apiary_id uuid NOT NULL REFERENCES apiaries(id),
  date timestamptz NOT NULL,
  total_extracted_weight double precision,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX harvest_sessions_apiary_id_idx ON harvest_sessions (apiary_id);

CREATE TABLE honey_harvests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES harvest_sessions(id),
  hive_id uuid NOT NULL REFERENCES hives(id),
  date timestamptz NOT NULL,
  super_weight_before double precision NOT NULL,
  super_weight_after double precision NOT NULL,
  calculated_honey_weight double precision NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX honey_harvests_session_id_idx ON honey_harvests (session_id);
CREATE INDEX honey_harvests_hive_id_idx ON honey_harvests (hive_id);

CREATE TABLE honey_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date timestamptz NOT NULL,
  customer_name text,
  location text,
  total_amount double precision NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Jar ledger (append-only; inventory derived by summing)
CREATE TABLE jar_sizes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL UNIQUE,
  honey_oz double precision,
  default_price double precision,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE honey_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date timestamptz NOT NULL,
  kind honey_movement_kind NOT NULL,
  amount_lbs double precision,
  jar_size_id uuid REFERENCES jar_sizes(id),
  quantity integer,
  reason text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX honey_movements_date_kind_idx ON honey_movements (date, kind);
CREATE INDEX honey_movements_jar_size_id_idx ON honey_movements (jar_size_id);

CREATE TABLE honey_sale_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES honey_sales(id) ON DELETE CASCADE,
  jar_size_id uuid NOT NULL REFERENCES jar_sizes(id),
  quantity integer NOT NULL,
  unit_price double precision NOT NULL
);
CREATE INDEX honey_sale_items_sale_id_idx ON honey_sale_items (sale_id);
CREATE INDEX honey_sale_items_jar_size_id_idx ON honey_sale_items (jar_size_id);

-- Equipment
CREATE TABLE equipment_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  category equipment_category NOT NULL,
  frames_per_box integer,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE equipment_stock (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_id uuid NOT NULL REFERENCES equipment_types(id),
  total_owned integer NOT NULL DEFAULT 0,
  frame_condition frame_condition,
  storage_location text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX equipment_stock_type_id_idx ON equipment_stock (type_id);
CREATE TRIGGER equipment_stock_updated_at BEFORE UPDATE ON equipment_stock FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE equipment_stock_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_id uuid NOT NULL REFERENCES equipment_stock(id),
  quantity integer NOT NULL,
  reason stock_adjustment_reason NOT NULL,
  notes text,
  date timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX equipment_stock_adjustments_stock_id_idx ON equipment_stock_adjustments (stock_id);

CREATE TABLE equipment_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_id uuid NOT NULL REFERENCES equipment_stock(id),
  hive_id uuid NOT NULL REFERENCES hives(id),
  quantity integer NOT NULL DEFAULT 1,
  date_deployed timestamptz NOT NULL,
  date_removed timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX equipment_deployments_stock_id_idx ON equipment_deployments (stock_id);
CREATE INDEX equipment_deployments_hive_id_idx ON equipment_deployments (hive_id);

-- Media (object keys point into MinIO)
CREATE TABLE photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type media_owner_type NOT NULL,
  owner_id uuid NOT NULL,
  original_key text NOT NULL,
  thumbnail_key text,
  medium_key text,
  taken_date timestamptz,
  caption text,
  tags jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX photos_owner_idx ON photos (owner_type, owner_id);

CREATE TABLE media_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audio_key text NOT NULL,
  transcription_text text,
  transcription_status transcription_status NOT NULL DEFAULT 'pending',
  transcription_error text,
  owner_type media_owner_type NOT NULL,
  owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_files_owner_idx ON media_files (owner_type, owner_id);
CREATE TRIGGER media_files_updated_at BEFORE UPDATE ON media_files FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Recommendations
CREATE TABLE ai_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid REFERENCES hives(id),
  type recommendation_type NOT NULL,
  message text NOT NULL,
  priority text NOT NULL DEFAULT 'normal',
  dismissed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_recommendations_hive_id_idx ON ai_recommendations (hive_id);

-- Bloom observations
CREATE TABLE bloom_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apiary_id uuid NOT NULL REFERENCES apiaries(id),
  species text NOT NULL,
  date_first_seen date NOT NULL,
  date_last_seen date,
  year integer NOT NULL,
  abundance integer,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bloom_observations_apiary_id_idx ON bloom_observations (apiary_id);

-- Settings & auth (single-row instance settings)
CREATE TABLE user_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  password_hash text,
  display_name text,
  ai_provider_config jsonb,
  theme text DEFAULT 'system',
  default_apiary_id uuid REFERENCES apiaries(id),
  date_format text DEFAULT 'MM/DD/YYYY',
  weight_unit text DEFAULT 'oz',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_settings_updated_at BEFORE UPDATE ON user_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE oidc_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer text NOT NULL,
  subject text NOT NULL,
  display_name text,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);

-- +goose Down
DROP TABLE IF EXISTS oidc_identities, user_settings, bloom_observations, ai_recommendations,
  media_files, photos, equipment_deployments, equipment_stock_adjustments, equipment_stock,
  equipment_types, honey_sale_items, honey_movements, jar_sizes, honey_sales, honey_harvests,
  harvest_sessions, feedings, inspections, queens, hive_splits, hive_location_history, hives,
  apiaries CASCADE;
DROP TYPE IF EXISTS honey_movement_kind, frame_condition, stock_adjustment_reason,
  equipment_category, split_type, recommendation_type, transcription_status, media_owner_type,
  quantity_unit, feeder_type, feed_type, queen_status, queen_origin, hive_placement, hive_status;
DROP FUNCTION IF EXISTS set_updated_at();
