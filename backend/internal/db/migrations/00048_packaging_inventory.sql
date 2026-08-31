-- +goose Up
-- Packaging inventory: empty jars, lids, and labels.
--
-- These were tracked nowhere — jar_sizes counts FILLED jars, and the only
-- packaging in the schema was an expense category (dollars, not counts). They
-- ride on the equipment ledger rather than a second inventory system, so they
-- inherit receive / adjust / physical count / unit cost / loss reporting, and
-- the bill of materials from 00046 ("1 lb jar = glass + lid + label").
--
-- Postgres forbids using a new enum value in the transaction that adds it, so
-- these are only added here; the handlers are the first writers.
ALTER TYPE equipment_category ADD VALUE IF NOT EXISTS 'packaging';
-- Jarring draws down the empties it filled.
ALTER TYPE stock_adjustment_reason ADD VALUE IF NOT EXISTS 'consumed';

-- The link that lets filling a jar size decrement the right empties. Nullable:
-- a jar size with no packaging type simply consumes nothing, which is what
-- every existing size does until an operator links one.
ALTER TABLE jar_sizes
  ADD COLUMN packaging_type_id uuid REFERENCES equipment_types(id) ON DELETE SET NULL;
CREATE INDEX jar_sizes_packaging_type_idx ON jar_sizes (packaging_type_id)
  WHERE packaging_type_id IS NOT NULL;

COMMENT ON COLUMN jar_sizes.packaging_type_id IS
  'Equipment type holding the empty containers for this size. Jarring consumes one per jar and warns, never blocks, when stock runs short.';

-- +goose Down
DROP INDEX IF EXISTS jar_sizes_packaging_type_idx;
ALTER TABLE jar_sizes DROP COLUMN IF EXISTS packaging_type_id;
-- 'packaging' and 'consumed' stay on their enums (Postgres cannot drop an
-- enum value).
