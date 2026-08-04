-- +goose Up
-- Ledger integrity: reversing entries instead of hard deletes, soft deletes
-- with an actor and a reason, a real foreign key between a bottling run and the
-- inventory movement that mirrors it, an audit trail for harvest-session
-- true-ups, and the external_sync mapping table the accounting integration
-- will key off (table + indexes only; no sync logic yet).

-- Reversing entries -----------------------------------------------------
-- A reversal is an ordinary movement whose quantity/amount negate another
-- movement. The link makes the pair discoverable, and the unique index means a
-- movement can be reversed exactly once.
ALTER TABLE honey_movements
  ADD COLUMN reverses_movement_id uuid REFERENCES honey_movements(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX honey_movements_reverses_idx
  ON honey_movements (reverses_movement_id)
  WHERE reverses_movement_id IS NOT NULL;

-- Bottling run <-> movement ---------------------------------------------
ALTER TABLE honey_movements
  ADD COLUMN bottling_run_id uuid REFERENCES bottling_runs(id) ON DELETE RESTRICT;
CREATE INDEX honey_movements_bottling_run_idx ON honey_movements (bottling_run_id);

-- Backfill the link from the legacy "bottling run LOT-CODE" reason string.
-- DISTINCT ON keeps the match deterministic when a lot has several identical
-- runs on the same day: each movement takes the oldest still-unclaimed run.
-- +goose StatementBegin
DO $$
DECLARE
  pair record;
BEGIN
  FOR pair IN
    SELECT movement.id AS movement_id, run.id AS run_id
    FROM honey_movements movement
    JOIN bottling_runs run ON run.jar_size_id = movement.jar_size_id
      AND run.quantity = movement.quantity
      AND run.bottled_date = (movement.date AT TIME ZONE 'UTC')::date
    JOIN harvest_lots lot ON lot.id = run.lot_id
    WHERE movement.kind = 'jarring'
      AND movement.bottling_run_id IS NULL
      AND movement.reason = 'bottling run ' || lot.lot_code
    ORDER BY movement.created_at, run.created_at
  LOOP
    -- Skip runs already claimed by an earlier movement in this loop.
    IF NOT EXISTS (
      SELECT 1 FROM honey_movements WHERE bottling_run_id = pair.run_id
    ) THEN
      UPDATE honey_movements SET bottling_run_id = pair.run_id
      WHERE id = pair.movement_id AND bottling_run_id IS NULL;
    END IF;
  END LOOP;
END
$$;
-- +goose StatementEnd

-- One formula for bulk-on-hand: /honey/overview sums stored amount_lbs while
-- /honey/production-plan recomputed quantity * honey_oz / 16. The handlers now
-- share the stored-amount formula, so jarring rows written before amount_lbs
-- was always populated are backfilled once, here, from the jar size they used.
-- Rows whose jar size never had a honey_oz become an explicit 0 rather than
-- NULL: the ledger records that no pounds were attributed, instead of leaving
-- the number undefined.
UPDATE honey_movements movement
SET amount_lbs = COALESCE(
  (SELECT movement.quantity * size.honey_oz / 16.0
   FROM jar_sizes size WHERE size.id = movement.jar_size_id), 0)
WHERE movement.kind = 'jarring' AND movement.amount_lbs IS NULL;

-- Sale cancellation ------------------------------------------------------
-- DELETE /honey/sales/{id} now cancels. Inventory already excludes cancelled
-- sales from the "sold" aggregate, so cancelling restores the jars without a
-- second ledger entry (emitting one would double-count them).
ALTER TABLE honey_sales
  ADD COLUMN cancelled_at        timestamptz,
  ADD COLUMN cancelled_by        uuid REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN cancellation_reason text;
UPDATE honey_sales SET cancelled_at = COALESCE(updated_at, created_at)
WHERE order_status = 'cancelled' AND cancelled_at IS NULL;

-- Soft deletes -----------------------------------------------------------
ALTER TABLE honey_harvests
  ADD COLUMN deleted_at      timestamptz,
  ADD COLUMN deleted_by      uuid REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN deletion_reason text;
CREATE INDEX honey_harvests_live_idx ON honey_harvests (session_id) WHERE deleted_at IS NULL;

ALTER TABLE expenses
  ADD COLUMN deleted_at      timestamptz,
  ADD COLUMN deleted_by      uuid REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN deletion_reason text;
CREATE INDEX expenses_live_date_idx ON expenses (expense_date DESC) WHERE deleted_at IS NULL;

-- Harvest-session true-up history ---------------------------------------
-- The true-up overwrote the authoritative extracted weight in place. The prior
-- value is now kept so the correction is auditable.
CREATE TABLE harvest_session_true_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES harvest_sessions(id) ON DELETE CASCADE,
  previous_weight_lbs double precision,
  new_weight_lbs double precision NOT NULL CHECK (new_weight_lbs >= 0),
  reason text,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX harvest_session_true_ups_session_idx
  ON harvest_session_true_ups (session_id, created_at DESC);

-- External accounting sync mapping --------------------------------------
-- Table and indexes only. One row maps one local entity to its counterpart in
-- an external system (gnucash-web first), together with the account/category/
-- tax mapping that entity resolves to and the state of the last sync attempt.
CREATE TABLE external_sync (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system text NOT NULL DEFAULT 'gnucash_web',
  entity_type text NOT NULL CHECK (
    entity_type IN (
      'honey_sale', 'honey_sale_item', 'expense', 'customer',
      'harvest_lot', 'jar_size', 'honey_movement', 'bottling_run'
    )
  ),
  entity_id uuid NOT NULL,
  external_id text,
  account_mapping jsonb,
  category_mapping jsonb,
  tax_mapping jsonb,
  sync_state text NOT NULL DEFAULT 'pending' CHECK (
    sync_state IN ('pending', 'synced', 'failed', 'ignored')
  ),
  conflict_state text CHECK (
    conflict_state IS NULL OR conflict_state IN ('none', 'local_newer', 'remote_newer', 'diverged')
  ),
  last_error text,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX external_sync_entity_idx
  ON external_sync (system, entity_type, entity_id);
CREATE UNIQUE INDEX external_sync_external_idx
  ON external_sync (system, entity_type, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX external_sync_state_idx ON external_sync (system, sync_state, last_synced_at);
CREATE TRIGGER external_sync_updated_at BEFORE UPDATE ON external_sync
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +goose Down
DROP TABLE IF EXISTS external_sync;
DROP TABLE IF EXISTS harvest_session_true_ups;
DROP INDEX IF EXISTS expenses_live_date_idx;
ALTER TABLE expenses
  DROP COLUMN IF EXISTS deletion_reason,
  DROP COLUMN IF EXISTS deleted_by,
  DROP COLUMN IF EXISTS deleted_at;
DROP INDEX IF EXISTS honey_harvests_live_idx;
ALTER TABLE honey_harvests
  DROP COLUMN IF EXISTS deletion_reason,
  DROP COLUMN IF EXISTS deleted_by,
  DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE honey_sales
  DROP COLUMN IF EXISTS cancellation_reason,
  DROP COLUMN IF EXISTS cancelled_by,
  DROP COLUMN IF EXISTS cancelled_at;
DROP INDEX IF EXISTS honey_movements_bottling_run_idx;
DROP INDEX IF EXISTS honey_movements_reverses_idx;
ALTER TABLE honey_movements
  DROP COLUMN IF EXISTS bottling_run_id,
  DROP COLUMN IF EXISTS reverses_movement_id;
