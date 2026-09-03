-- +goose Up
-- Snapshot equipment unit cost at the moment a sale consumes stock, and
-- store a per-line cost basis on sale_items so later price edits cannot
-- rewrite historical COGS.
--
-- equipment_stock_adjustments already has unit_cost_cents (the cost on a
-- receive/adjust). Sold rows need a dedicated snapshot because they were
-- written without a cost, and reuse of unit_cost_cents would conflate
-- purchase-price-on-the-movement with COGS-at-sale-time.
--
-- sale_items.cost_basis_cents is quantity * unit snapshot for equipment
-- lines, and SUM(bees_queens expenses) for colony lines. NULL means no
-- recorded basis (unknown cost), which is distinct from a basis of zero.

ALTER TABLE equipment_stock_adjustments
  ADD COLUMN unit_cost_cents_snapshot integer
    CHECK (unit_cost_cents_snapshot IS NULL OR unit_cost_cents_snapshot >= 0);

ALTER TABLE sale_items
  ADD COLUMN cost_basis_cents bigint
    CHECK (cost_basis_cents IS NULL OR cost_basis_cents >= 0);

COMMENT ON COLUMN equipment_stock_adjustments.unit_cost_cents_snapshot IS
  'Unit cost frozen when reason=sold. Later edits to equipment_stock.unit_cost_cents must not rewrite this.';
COMMENT ON COLUMN sale_items.cost_basis_cents IS
  'COGS frozen at physical apply. Equipment: quantity * unit_cost_cents_snapshot. Colony: SUM of live bees_queens expenses for the hive. NULL = no recorded basis.';

-- +goose Down
ALTER TABLE sale_items DROP COLUMN IF EXISTS cost_basis_cents;
ALTER TABLE equipment_stock_adjustments DROP COLUMN IF EXISTS unit_cost_cents_snapshot;
