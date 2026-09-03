-- +goose Up
-- Re-key equipment sale lines onto the ledger identity (design review OV2).
--
-- Migration 00020 made `kind='equipment'` mean "equipment_stock_id IS NOT
-- NULL". Under the ledger a sale line names an `inventory_items` row, and
-- `equipment_stock` is scheduled to be dropped in Phase B, so the CHECK has
-- to stop demanding a column that is on its way out. The target for an
-- equipment line is now `item_id`, exactly as it already is for jars and
-- products on the read path.
--
-- `equipment_stock_id` itself is left in place: existing rows keep it, the
-- GnuCash feed still reads it for historical sales, and Phase B drops the
-- column with the table. New rows simply stop populating it.
--
-- The relaxation is one-directional — every clause that previously passed
-- still passes, plus the item-keyed equipment shape — so no existing row can
-- be invalidated by the swap.

ALTER TABLE sale_items DROP CONSTRAINT IF EXISTS sale_items_target_check;

ALTER TABLE sale_items
  ADD CONSTRAINT sale_items_target_check CHECK (
    (kind = 'jar'
      AND jar_size_id IS NOT NULL
      AND hive_id IS NULL
      AND equipment_stock_id IS NULL
      AND product_id IS NULL)
    OR (kind = 'colony'
      AND hive_id IS NOT NULL
      AND jar_size_id IS NULL
      AND equipment_stock_id IS NULL
      AND product_id IS NULL)
    OR (kind = 'equipment'
      AND (item_id IS NOT NULL OR equipment_stock_id IS NOT NULL)
      AND jar_size_id IS NULL
      AND hive_id IS NULL
      AND product_id IS NULL)
    OR (kind IN ('creamed_honey', 'hot_honey', 'mead', 'propolis', 'tincture')
      AND product_id IS NOT NULL
      AND jar_size_id IS NULL
      AND hive_id IS NULL
      AND equipment_stock_id IS NULL)
  );

-- +goose Down

-- Going back means equipment lines must once again carry equipment_stock_id.
-- Rows written under the ledger have only item_id, so the down migration
-- cannot invent a stock row for them; they are removed rather than left to
-- fail the restored CHECK.
DELETE FROM sale_items WHERE kind = 'equipment' AND equipment_stock_id IS NULL;

ALTER TABLE sale_items DROP CONSTRAINT IF EXISTS sale_items_target_check;

ALTER TABLE sale_items
  ADD CONSTRAINT sale_items_target_check CHECK (
    (kind = 'jar'
      AND jar_size_id IS NOT NULL
      AND hive_id IS NULL
      AND equipment_stock_id IS NULL
      AND product_id IS NULL)
    OR (kind = 'colony'
      AND hive_id IS NOT NULL
      AND jar_size_id IS NULL
      AND equipment_stock_id IS NULL
      AND product_id IS NULL)
    OR (kind = 'equipment'
      AND equipment_stock_id IS NOT NULL
      AND jar_size_id IS NULL
      AND hive_id IS NULL
      AND product_id IS NULL)
    OR (kind IN ('creamed_honey', 'hot_honey', 'mead', 'propolis', 'tincture')
      AND product_id IS NOT NULL
      AND jar_size_id IS NULL
      AND hive_id IS NULL
      AND equipment_stock_id IS NULL)
  );
