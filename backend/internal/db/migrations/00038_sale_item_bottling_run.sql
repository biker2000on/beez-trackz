-- +goose Up
-- Trace a jar sale line back to the bottling run that filled it.
--
-- sale_items carried no lot reference at all: the only link was the optional
-- sale-level sales.harvest_lot_id, so a mixed sale of jars from three lots
-- recorded none of them. That also left refuseLotSale unreachable for the
-- ordinary case — a jar sale that names no lot could not be checked against a
-- treatment withdrawal window, and the bottling run was the last chokepoint.
--
-- The run, not the lot, is the reference: it pins the jar size and the date
-- the jars were filled, and resolves to exactly one lot. ON DELETE RESTRICT
-- because a sold jar's provenance must not become undecidable; runs are
-- voided (00023), never deleted.
--
-- Nullable on purpose: every sale recorded before this migration stays valid.

ALTER TABLE sale_items
  ADD COLUMN bottling_run_id uuid REFERENCES bottling_runs(id) ON DELETE RESTRICT;

-- Only a jar line can come off a bottling run. A colony, an equipment lot, or
-- a catalog SKU has no run, and letting one carry a run would make the lot
-- rollup double-count.
ALTER TABLE sale_items
  ADD CONSTRAINT sale_items_bottling_run_jar_only
  CHECK (bottling_run_id IS NULL OR kind = 'jar');

CREATE INDEX sale_items_bottling_run_idx
  ON sale_items (bottling_run_id)
  WHERE bottling_run_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS sale_items_bottling_run_idx;
ALTER TABLE sale_items
  DROP CONSTRAINT IF EXISTS sale_items_bottling_run_jar_only;
ALTER TABLE sale_items
  DROP COLUMN IF EXISTS bottling_run_id;
