-- +goose Up
-- Treatment withdrawal catalog, stamped days on each event, lot/session
-- moisture, and the harvest moisture threshold.

CREATE TABLE treatment_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  name_key text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
  aliases text[] NOT NULL DEFAULT '{}',
  withdrawal_days integer NOT NULL CHECK (withdrawal_days >= 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name_key)
);
CREATE TRIGGER treatment_products_updated_at BEFORE UPDATE ON treatment_products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO treatment_products (name, aliases, withdrawal_days, notes) VALUES
  ('Apivar', ARRAY['amitraz', 'apivar strips'], 0,
    'Do not harvest while strips are in. Zero days after removal.'),
  ('Apistan', ARRAY['fluvalinate'], 0, NULL),
  ('CheckMite+', ARRAY['checkmite', 'checkmite+', 'coumaphos'], 0, NULL),
  ('Formic Pro', ARRAY['formic acid', 'maqs', 'mite away', 'mite-away'], 0,
    'Some labels allow harvest during treatment. Record date_removed to clear the lock.'),
  ('Apiguard', ARRAY['thymol'], 0, NULL),
  ('ApiLife Var', ARRAY['apilife', 'apilife var'], 0, NULL),
  ('Oxalic acid', ARRAY['oa', 'oa vapor', 'oa dribble', 'oxalic'], 0,
    'One-shot: set date_removed to the application date.'),
  ('HopGuard', ARRAY['hopguard 3', 'hops beta acids'], 0, NULL);

ALTER TABLE treatment_events
  ADD COLUMN withdrawal_days integer
    CHECK (withdrawal_days IS NULL OR withdrawal_days >= 0);

UPDATE treatment_events t
SET withdrawal_days = p.withdrawal_days
FROM treatment_products p
WHERE t.withdrawal_days IS NULL
  AND (
    lower(btrim(t.product)) = p.name_key
    OR EXISTS (
      SELECT 1 FROM unnest(p.aliases) alias
      WHERE lower(btrim(alias)) = lower(btrim(t.product))
    )
  );

UPDATE treatment_events SET withdrawal_days = 0 WHERE withdrawal_days IS NULL;

ALTER TABLE treatment_events
  ALTER COLUMN withdrawal_days SET DEFAULT 0,
  ALTER COLUMN withdrawal_days SET NOT NULL;

ALTER TABLE harvest_sessions
  ADD COLUMN moisture_pct double precision
    CHECK (moisture_pct IS NULL OR (moisture_pct >= 0 AND moisture_pct <= 100));

ALTER TABLE harvest_lots
  ADD COLUMN moisture_pct double precision
    CHECK (moisture_pct IS NULL OR (moisture_pct >= 0 AND moisture_pct <= 100)),
  ADD COLUMN bottling_moisture_pct double precision
    CHECK (bottling_moisture_pct IS NULL OR (bottling_moisture_pct >= 0 AND bottling_moisture_pct <= 100));

ALTER TABLE user_settings
  ADD COLUMN moisture_threshold_pct double precision
    CHECK (moisture_threshold_pct IS NULL OR (moisture_threshold_pct > 0 AND moisture_threshold_pct <= 100));

-- +goose Down
ALTER TABLE user_settings DROP COLUMN IF EXISTS moisture_threshold_pct;
ALTER TABLE harvest_lots
  DROP COLUMN IF EXISTS bottling_moisture_pct,
  DROP COLUMN IF EXISTS moisture_pct;
ALTER TABLE harvest_sessions DROP COLUMN IF EXISTS moisture_pct;
ALTER TABLE treatment_events DROP COLUMN IF EXISTS withdrawal_days;
DROP TABLE IF EXISTS treatment_products;
