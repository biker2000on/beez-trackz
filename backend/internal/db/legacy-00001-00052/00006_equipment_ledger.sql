-- +goose Up
-- Equipment ledger integrity (roadmap P1 "Separate operational inventories").
--
-- Model after this migration:
--
--   total_owned      = SUM(equipment_stock_adjustments.quantity)   [ownership ledger]
--   damaged_quantity = state ledger movements into/out of 'damaged'
--   retired_quantity = state ledger movements into/out of 'retired'
--   deployed         = SUM(quantity - quantity_returned) over deployments
--   available        = total_owned - damaged - retired - deployed
--
-- The three materialized columns are recomputed by triggers from their ledgers
-- and a BEFORE INSERT/UPDATE guard rejects any write that would leave them out
-- of sync, so "nothing reconciles them" is no longer possible: the database
-- itself is the reconciliation check. `equipment_stock_reconciliation` exposes
-- the comparison for reporting.

-- 'physical_count' replaces the old opaque bulk edit. It is only added here;
-- Postgres forbids using a new enum value in the transaction that adds it.
ALTER TYPE stock_adjustment_reason ADD VALUE IF NOT EXISTS 'physical_count';

-- --------------------------------------------------------------------------
-- 1. Columns: needed / cost (integer cents) / state quantities / audit fields
-- --------------------------------------------------------------------------

ALTER TABLE equipment_types
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN created_by uuid REFERENCES app_users(id) ON DELETE SET NULL;
CREATE TRIGGER equipment_types_updated_at BEFORE UPDATE ON equipment_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE equipment_stock
  ADD COLUMN needed_quantity integer NOT NULL DEFAULT 0
    CHECK (needed_quantity >= 0),
  ADD COLUMN unit_cost_cents integer
    CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  ADD COLUMN damaged_quantity integer NOT NULL DEFAULT 0
    CHECK (damaged_quantity >= 0),
  ADD COLUMN retired_quantity integer NOT NULL DEFAULT 0
    CHECK (retired_quantity >= 0),
  ADD COLUMN created_by uuid REFERENCES app_users(id) ON DELETE SET NULL;

ALTER TABLE equipment_stock_adjustments
  ADD COLUMN unit_cost_cents integer
    CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN created_by uuid REFERENCES app_users(id) ON DELETE SET NULL;
CREATE TRIGGER equipment_stock_adjustments_updated_at
  BEFORE UPDATE ON equipment_stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX equipment_stock_adjustments_date_idx
  ON equipment_stock_adjustments (date);

ALTER TABLE equipment_deployments
  ADD COLUMN quantity_returned integer NOT NULL DEFAULT 0,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN created_by uuid REFERENCES app_users(id) ON DELETE SET NULL;
CREATE TRIGGER equipment_deployments_updated_at
  BEFORE UPDATE ON equipment_deployments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Legacy returns were all-or-nothing: a removal date means everything came back.
UPDATE equipment_deployments
SET quantity_returned = quantity
WHERE date_removed IS NOT NULL;

ALTER TABLE equipment_deployments
  ADD CONSTRAINT equipment_deployments_returned_range
    CHECK (quantity_returned >= 0 AND quantity_returned <= quantity),
  ADD CONSTRAINT equipment_deployments_removed_when_complete
    CHECK (date_removed IS NULL OR quantity_returned = quantity);

-- --------------------------------------------------------------------------
-- 2. Return ledger: partial quantities with a reason and a condition
-- --------------------------------------------------------------------------

CREATE TABLE equipment_deployment_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL REFERENCES equipment_deployments(id) ON DELETE CASCADE,
  quantity integer NOT NULL CHECK (quantity > 0),
  reason text NOT NULL CHECK (reason IN (
    'season_end', 'no_longer_needed', 'maintenance', 'damaged',
    'hive_removed', 'other')),
  condition text NOT NULL CHECK (condition IN ('good', 'damaged', 'retired')),
  notes text,
  date timestamptz NOT NULL,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX equipment_deployment_returns_deployment_idx
  ON equipment_deployment_returns (deployment_id);
CREATE TRIGGER equipment_deployment_returns_updated_at
  BEFORE UPDATE ON equipment_deployment_returns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Preserve the history that the old date-only return recorded.
INSERT INTO equipment_deployment_returns
  (deployment_id, quantity, reason, condition, notes, date)
SELECT id, quantity, 'other', 'good',
       'Migrated from legacy return (no reason or condition was recorded)',
       date_removed
FROM equipment_deployments
WHERE date_removed IS NOT NULL AND quantity > 0;

-- --------------------------------------------------------------------------
-- 3. State ledger: real damaged / retired states with quantities
-- --------------------------------------------------------------------------

CREATE TYPE equipment_state AS ENUM ('serviceable', 'damaged', 'retired');

CREATE TABLE equipment_state_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_id uuid NOT NULL REFERENCES equipment_stock(id) ON DELETE CASCADE,
  from_state equipment_state NOT NULL,
  to_state equipment_state NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  reason text NOT NULL CHECK (reason IN (
    'broken', 'worn_out', 'pest_damage', 'weather', 'lost', 'obsolete',
    'repaired', 'sold', 'disposed', 'returned_damaged', 'other')),
  notes text,
  -- Snapshot of the unit cost at the time of loss, so a later price change
  -- cannot rewrite the value of an already-reported loss.
  unit_cost_cents integer CHECK (unit_cost_cents IS NULL OR unit_cost_cents >= 0),
  date timestamptz NOT NULL,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT equipment_state_changes_distinct_states CHECK (from_state <> to_state)
);
CREATE INDEX equipment_state_changes_stock_idx ON equipment_state_changes (stock_id);
CREATE INDEX equipment_state_changes_date_idx ON equipment_state_changes (date);
CREATE TRIGGER equipment_state_changes_updated_at
  BEFORE UPDATE ON equipment_state_changes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- 4. Ledger -> column synchronisation and the reconciliation guard
-- --------------------------------------------------------------------------

-- +goose StatementBegin
CREATE FUNCTION equipment_stock_ledger_totals(target uuid)
RETURNS TABLE (owned integer, damaged integer, retired integer)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE((
      SELECT SUM(quantity)::int FROM equipment_stock_adjustments
      WHERE stock_id = target), 0),
    COALESCE((
      SELECT SUM(CASE
        WHEN to_state = 'damaged' THEN quantity
        WHEN from_state = 'damaged' THEN -quantity
        ELSE 0 END)::int
      FROM equipment_state_changes WHERE stock_id = target), 0),
    COALESCE((
      SELECT SUM(CASE
        WHEN to_state = 'retired' THEN quantity
        WHEN from_state = 'retired' THEN -quantity
        ELSE 0 END)::int
      FROM equipment_state_changes WHERE stock_id = target), 0);
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION equipment_stock_sync(target uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  totals record;
BEGIN
  SELECT * INTO totals FROM equipment_stock_ledger_totals(target);
  UPDATE equipment_stock
  SET total_owned = totals.owned,
      damaged_quantity = totals.damaged,
      retired_quantity = totals.retired
  WHERE id = target
    AND (total_owned, damaged_quantity, retired_quantity)
        IS DISTINCT FROM (totals.owned, totals.damaged, totals.retired);
END;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION equipment_stock_reconcile_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  totals record;
BEGIN
  SELECT * INTO totals FROM equipment_stock_ledger_totals(NEW.id);
  IF NEW.total_owned <> totals.owned THEN
    RAISE EXCEPTION
      'equipment_stock.total_owned (%) does not reconcile with the adjustment ledger (%)',
      NEW.total_owned, totals.owned USING ERRCODE = '23514';
  END IF;
  IF NEW.damaged_quantity <> totals.damaged THEN
    RAISE EXCEPTION
      'equipment_stock.damaged_quantity (%) does not reconcile with the state ledger (%)',
      NEW.damaged_quantity, totals.damaged USING ERRCODE = '23514';
  END IF;
  IF NEW.retired_quantity <> totals.retired THEN
    RAISE EXCEPTION
      'equipment_stock.retired_quantity (%) does not reconcile with the state ledger (%)',
      NEW.retired_quantity, totals.retired USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION equipment_ledger_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM equipment_stock_sync(OLD.stock_id);
    RETURN NULL;
  END IF;
  PERFORM equipment_stock_sync(NEW.stock_id);
  IF TG_OP = 'UPDATE' AND OLD.stock_id <> NEW.stock_id THEN
    PERFORM equipment_stock_sync(OLD.stock_id);
  END IF;
  RETURN NULL;
END;
$$;
-- +goose StatementEnd

-- Reconcile the drift that accumulated while only application code kept
-- total_owned in step with the ledger. The stored count is treated as
-- authoritative (it is what the beekeeper has been looking at) and the
-- difference is written into the ledger as an explicit, auditable entry.
INSERT INTO equipment_stock_adjustments (stock_id, quantity, reason, notes, date)
SELECT es.id,
       es.total_owned - COALESCE(led.total, 0),
       'other',
       'Ledger reconciliation (migration 00006): stored total was ' ||
         es.total_owned || ', ledger summed to ' || COALESCE(led.total, 0),
       now()
FROM equipment_stock es
LEFT JOIN (
  SELECT stock_id, SUM(quantity)::int AS total
  FROM equipment_stock_adjustments GROUP BY stock_id
) led ON led.stock_id = es.id
WHERE es.total_owned <> COALESCE(led.total, 0);

CREATE TRIGGER equipment_stock_adjustments_sync
  AFTER INSERT OR UPDATE OR DELETE ON equipment_stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION equipment_ledger_sync();

CREATE TRIGGER equipment_state_changes_sync
  AFTER INSERT OR UPDATE OR DELETE ON equipment_state_changes
  FOR EACH ROW EXECUTE FUNCTION equipment_ledger_sync();

CREATE TRIGGER equipment_stock_reconcile
  BEFORE INSERT OR UPDATE ON equipment_stock
  FOR EACH ROW EXECUTE FUNCTION equipment_stock_reconcile_guard();

-- --------------------------------------------------------------------------
-- 5. One stock row per equipment type
-- --------------------------------------------------------------------------

-- Kept as a permanent, idempotent maintenance function so the merge can be
-- exercised by tests and re-run after a bad import, not only during upgrade.
-- +goose StatementBegin
CREATE FUNCTION equipment_merge_duplicate_stock() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  merged integer := 0;
BEGIN
  CREATE TEMP TABLE equipment_stock_merge_map ON COMMIT DROP AS
  WITH ranked AS (
    SELECT id, type_id,
           first_value(id) OVER (
             PARTITION BY type_id
             ORDER BY total_owned DESC, created_at, id) AS canonical_id
    FROM equipment_stock
  )
  SELECT id AS from_id, canonical_id AS to_id
  FROM ranked
  WHERE id <> canonical_id;

  SELECT count(*) INTO merged FROM equipment_stock_merge_map;
  IF merged = 0 THEN
    DROP TABLE equipment_stock_merge_map;
    RETURN 0;
  END IF;

  -- Repointing the ledgers moves the history; the sync triggers move the
  -- totals with it, so the surviving row ends up owning the summed quantity
  -- without anyone writing total_owned by hand.
  UPDATE equipment_stock_adjustments a
  SET stock_id = m.to_id
  FROM equipment_stock_merge_map m
  WHERE a.stock_id = m.from_id;

  UPDATE equipment_deployments d
  SET stock_id = m.to_id
  FROM equipment_stock_merge_map m
  WHERE d.stock_id = m.from_id;

  UPDATE equipment_state_changes c
  SET stock_id = m.to_id
  FROM equipment_stock_merge_map m
  WHERE c.stock_id = m.from_id;

  WITH agg AS (
    SELECT m.to_id,
           MIN(dup.storage_location) AS storage_location,
           string_agg(DISTINCT dup.notes, ' | ') AS notes,
           MAX(dup.unit_cost_cents) AS unit_cost_cents,
           MAX(dup.needed_quantity) AS needed_quantity,
           count(DISTINCT dup.frame_condition) AS condition_count,
           MIN(dup.frame_condition::text) AS one_condition
    FROM equipment_stock_merge_map m
    JOIN equipment_stock dup ON dup.id = m.from_id
    GROUP BY m.to_id
  )
  UPDATE equipment_stock es
  SET storage_location = COALESCE(es.storage_location, agg.storage_location),
      notes = NULLIF(concat_ws(' | ', es.notes, agg.notes), ''),
      unit_cost_cents = COALESCE(es.unit_cost_cents, agg.unit_cost_cents),
      needed_quantity = GREATEST(es.needed_quantity, COALESCE(agg.needed_quantity, 0)),
      -- A merged row can only claim a frame condition when every row that fed
      -- it agreed; otherwise the honest answer is "unspecified".
      frame_condition = CASE
        WHEN es.frame_condition IS NULL AND agg.condition_count = 1
          THEN agg.one_condition::frame_condition
        WHEN es.frame_condition IS NOT NULL
          AND (agg.condition_count = 0
               OR (agg.condition_count = 1
                   AND agg.one_condition = es.frame_condition::text))
          THEN es.frame_condition
        ELSE NULL
      END
  FROM agg
  WHERE es.id = agg.to_id;

  DELETE FROM equipment_stock
  WHERE id IN (SELECT from_id FROM equipment_stock_merge_map);

  DROP TABLE equipment_stock_merge_map;
  RETURN merged;
END;
$$;
-- +goose StatementEnd

SELECT equipment_merge_duplicate_stock();

DROP INDEX IF EXISTS equipment_stock_type_id_idx;
ALTER TABLE equipment_stock
  ADD CONSTRAINT equipment_stock_type_id_key UNIQUE (type_id);

-- --------------------------------------------------------------------------
-- 6. Read models: one formula per number
-- --------------------------------------------------------------------------

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

CREATE VIEW equipment_stock_reconciliation AS
SELECT
  es.id AS stock_id,
  et.name AS type_name,
  es.total_owned,
  led.owned AS ledger_total_owned,
  es.damaged_quantity,
  led.damaged AS ledger_damaged,
  es.retired_quantity,
  led.retired AS ledger_retired,
  (es.total_owned = led.owned
   AND es.damaged_quantity = led.damaged
   AND es.retired_quantity = led.retired) AS reconciled
FROM equipment_stock es
JOIN equipment_types et ON et.id = es.type_id
CROSS JOIN LATERAL equipment_stock_ledger_totals(es.id) AS led;

-- Every event that removes equipment from service, in one place, so the loss
-- report has a single formula regardless of the date window applied on top.
CREATE VIEW equipment_loss_events AS
SELECT
  sc.id AS event_id,
  sc.stock_id,
  es.type_id,
  et.name AS type_name,
  et.category::text AS type_category,
  sc.date,
  sc.to_state::text AS kind,
  sc.quantity,
  sc.reason,
  sc.notes,
  COALESCE(sc.unit_cost_cents, es.unit_cost_cents) AS unit_cost_cents,
  sc.quantity * COALESCE(sc.unit_cost_cents, es.unit_cost_cents, 0) AS value_cents
FROM equipment_state_changes sc
JOIN equipment_stock es ON es.id = sc.stock_id
JOIN equipment_types et ON et.id = es.type_id
WHERE sc.to_state IN ('damaged', 'retired')
UNION ALL
SELECT
  a.id,
  a.stock_id,
  es.type_id,
  et.name,
  et.category::text,
  a.date,
  'written_off',
  -a.quantity,
  a.reason::text,
  a.notes,
  COALESCE(a.unit_cost_cents, es.unit_cost_cents),
  (-a.quantity) * COALESCE(a.unit_cost_cents, es.unit_cost_cents, 0)
FROM equipment_stock_adjustments a
JOIN equipment_stock es ON es.id = a.stock_id
JOIN equipment_types et ON et.id = es.type_id
WHERE a.quantity < 0 AND a.reason IN ('discarded', 'broken', 'gifted');

-- +goose Down
DROP VIEW IF EXISTS equipment_loss_events;
DROP VIEW IF EXISTS equipment_stock_reconciliation;
DROP VIEW IF EXISTS equipment_stock_status;

ALTER TABLE equipment_stock DROP CONSTRAINT IF EXISTS equipment_stock_type_id_key;
CREATE INDEX IF NOT EXISTS equipment_stock_type_id_idx ON equipment_stock (type_id);

DROP FUNCTION IF EXISTS equipment_merge_duplicate_stock();
DROP TRIGGER IF EXISTS equipment_stock_reconcile ON equipment_stock;
DROP TRIGGER IF EXISTS equipment_state_changes_sync ON equipment_state_changes;
DROP TRIGGER IF EXISTS equipment_stock_adjustments_sync ON equipment_stock_adjustments;
DROP FUNCTION IF EXISTS equipment_ledger_sync();
DROP FUNCTION IF EXISTS equipment_stock_reconcile_guard();
DROP FUNCTION IF EXISTS equipment_stock_sync(uuid);
DROP FUNCTION IF EXISTS equipment_stock_ledger_totals(uuid);

DROP TABLE IF EXISTS equipment_state_changes;
DROP TYPE IF EXISTS equipment_state;
DROP TABLE IF EXISTS equipment_deployment_returns;

DROP TRIGGER IF EXISTS equipment_deployments_updated_at ON equipment_deployments;
ALTER TABLE equipment_deployments
  DROP CONSTRAINT IF EXISTS equipment_deployments_removed_when_complete,
  DROP CONSTRAINT IF EXISTS equipment_deployments_returned_range,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS quantity_returned;

DROP INDEX IF EXISTS equipment_stock_adjustments_date_idx;
DROP TRIGGER IF EXISTS equipment_stock_adjustments_updated_at ON equipment_stock_adjustments;
ALTER TABLE equipment_stock_adjustments
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS unit_cost_cents;

ALTER TABLE equipment_stock
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS retired_quantity,
  DROP COLUMN IF EXISTS damaged_quantity,
  DROP COLUMN IF EXISTS unit_cost_cents,
  DROP COLUMN IF EXISTS needed_quantity;

DROP TRIGGER IF EXISTS equipment_types_updated_at ON equipment_types;
ALTER TABLE equipment_types
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS updated_at;

-- Note: merged stock rows are not un-merged and the 'physical_count' value
-- stays on stock_adjustment_reason (Postgres cannot drop an enum value).
