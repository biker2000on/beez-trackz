-- +goose Up
-- Units preference, ntfy, labor minutes, and canonical mass for currently
-- ambiguous propolis / lot-weight storage. Existing honey lbs columns stay
-- as-is (conversion layer first; do not rewrite canonical units).

ALTER TABLE user_settings
  ADD COLUMN units text
    CHECK (units IS NULL OR units IN ('metric', 'us')),
  ADD COLUMN temperature_unit text
    CHECK (temperature_unit IS NULL OR temperature_unit IN ('c', 'f')),
  ADD COLUMN labor_tracking_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN ntfy_server_url text,
  ADD COLUMN ntfy_topic text,
  ADD COLUMN ntfy_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN ntfy_event_kinds text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN user_settings.units IS
  'Display system: metric or us. NULL means unset; the client defaults from locale.';
COMMENT ON COLUMN user_settings.temperature_unit IS
  'Optional temperature override (c or f). NULL follows units.';
COMMENT ON COLUMN user_settings.labor_tracking_enabled IS
  'Yard-visit start/stop. Off by default; do not guilt a hobbyist.';

-- Canonical grams derived from the still-ambiguous amount+unit pair.
-- 28.349523125 g/oz is the international avoirdupois ounce.
ALTER TABLE propolis_harvests
  ADD COLUMN amount_grams double precision GENERATED ALWAYS AS (
    CASE
      WHEN unit = 'ounces' THEN amount * 28.349523125
      ELSE amount
    END
  ) STORED;

ALTER TABLE product_batches
  ADD COLUMN propolis_amount_grams double precision GENERATED ALWAYS AS (
    CASE
      WHEN propolis_amount IS NULL THEN NULL
      WHEN propolis_unit = 'ounces' THEN propolis_amount * 28.349523125
      ELSE propolis_amount
    END
  ) STORED;

-- Preserve the typed lot-weight string ("2 kg", "4.4 lb") without migrating
-- honey_weight_lbs, which remains the canonical pound column.
ALTER TABLE harvest_lots
  ADD COLUMN honey_weight_entered text;

-- Optional start/stop on a yard visit. Minutes are derived from the timestamps.
CREATE TABLE yard_labor_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apiary_id uuid REFERENCES apiaries(id),
  started_at timestamptz NOT NULL,
  stopped_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  CONSTRAINT yard_labor_sessions_stop_check CHECK (
    stopped_at IS NULL OR stopped_at >= started_at
  )
);
CREATE TRIGGER yard_labor_sessions_updated_at BEFORE UPDATE ON yard_labor_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX yard_labor_sessions_apiary_idx ON yard_labor_sessions (apiary_id)
  WHERE apiary_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX yard_labor_sessions_live_idx ON yard_labor_sessions (started_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX yard_labor_sessions_created_by_idx ON yard_labor_sessions (created_by)
  WHERE created_by IS NOT NULL;
-- One open visit per operator. NULL created_by is not constrained (Postgres
-- unique indexes treat NULL as distinct).
CREATE UNIQUE INDEX yard_labor_sessions_open_user_uidx
  ON yard_labor_sessions (created_by)
  WHERE stopped_at IS NULL AND deleted_at IS NULL AND created_by IS NOT NULL;

-- Dedupe for ntfy so a still-open yard-queue item is not re-pushed.
CREATE TABLE ntfy_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_kind text NOT NULL CHECK (event_kind IN (
    'mite_check_due', 'feeder_empty', 'treatment_off_date', 'flow_started')),
  event_key text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_kind, event_key)
);
CREATE INDEX ntfy_dispatches_kind_idx ON ntfy_dispatches (event_kind, dispatched_at DESC);

-- +goose Down
DROP TABLE IF EXISTS ntfy_dispatches;
DROP TABLE IF EXISTS yard_labor_sessions;
ALTER TABLE harvest_lots DROP COLUMN IF EXISTS honey_weight_entered;
ALTER TABLE product_batches DROP COLUMN IF EXISTS propolis_amount_grams;
ALTER TABLE propolis_harvests DROP COLUMN IF EXISTS amount_grams;
ALTER TABLE user_settings
  DROP COLUMN IF EXISTS ntfy_event_kinds,
  DROP COLUMN IF EXISTS ntfy_enabled,
  DROP COLUMN IF EXISTS ntfy_topic,
  DROP COLUMN IF EXISTS ntfy_server_url,
  DROP COLUMN IF EXISTS labor_tracking_enabled,
  DROP COLUMN IF EXISTS temperature_unit,
  DROP COLUMN IF EXISTS units;
