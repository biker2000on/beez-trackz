-- +goose Up
-- Mixed sales: one transaction can sell honey jars, colonies (specific hives),
-- and equipment. Rename honey_sales / honey_sale_items to sales / sale_items
-- (no compatibility views) and give each line a kind + exactly one target.
--
-- 00020 will extend sale_items_kind_check with creamed / hot / mead / propolis.

-- --------------------------------------------------------------------------
-- 1. Rename the sale tables and their indexes
-- --------------------------------------------------------------------------

ALTER TABLE honey_sales RENAME TO sales;
ALTER TABLE honey_sale_items RENAME TO sale_items;

ALTER INDEX IF EXISTS honey_sales_order_number_idx RENAME TO sales_order_number_idx;
ALTER INDEX IF EXISTS honey_sales_channel_date_idx RENAME TO sales_channel_date_idx;
ALTER INDEX IF EXISTS honey_sales_customer_idx RENAME TO sales_customer_idx;
ALTER INDEX IF EXISTS honey_sales_harvest_lot_idx RENAME TO sales_harvest_lot_idx;
ALTER INDEX IF EXISTS honey_sale_items_sale_id_idx RENAME TO sale_items_sale_id_idx;
ALTER INDEX IF EXISTS honey_sale_items_jar_size_id_idx RENAME TO sale_items_jar_size_id_idx;
ALTER INDEX IF EXISTS honey_sales_created_by_idx RENAME TO sales_created_by_idx;
ALTER INDEX IF EXISTS honey_sale_items_created_by_idx RENAME TO sale_items_created_by_idx;

ALTER TABLE sales RENAME CONSTRAINT honey_sales_pkey TO sales_pkey;
ALTER TABLE sale_items RENAME CONSTRAINT honey_sale_items_pkey TO sale_items_pkey;

-- --------------------------------------------------------------------------
-- 2. Line kinds and per-kind targets
-- --------------------------------------------------------------------------

ALTER TABLE sale_items
  ALTER COLUMN jar_size_id DROP NOT NULL,
  ADD COLUMN kind text NOT NULL DEFAULT 'jar',
  ADD COLUMN hive_id uuid REFERENCES hives(id),
  ADD COLUMN equipment_stock_id uuid REFERENCES equipment_stock(id);

-- Existing rows already have jar_size_id set; the default makes them kind=jar.
UPDATE sale_items SET kind = 'jar' WHERE kind IS NULL OR kind = '';

-- 00020 will extend this CHECK with more product kinds. Do not treat the
-- list as closed in application code beyond what this constraint allows.
ALTER TABLE sale_items
  ADD CONSTRAINT sale_items_kind_check
    CHECK (kind IN ('jar', 'colony', 'equipment')),
  ADD CONSTRAINT sale_items_target_check
    CHECK (
      (kind = 'jar'
        AND jar_size_id IS NOT NULL
        AND hive_id IS NULL
        AND equipment_stock_id IS NULL)
      OR (kind = 'colony'
        AND hive_id IS NOT NULL
        AND jar_size_id IS NULL
        AND equipment_stock_id IS NULL)
      OR (kind = 'equipment'
        AND equipment_stock_id IS NOT NULL
        AND jar_size_id IS NULL
        AND hive_id IS NULL)
    );

CREATE INDEX sale_items_hive_id_idx ON sale_items (hive_id)
  WHERE hive_id IS NOT NULL;
CREATE INDEX sale_items_equipment_stock_id_idx ON sale_items (equipment_stock_id)
  WHERE equipment_stock_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- 3. Hive sale link
-- --------------------------------------------------------------------------

ALTER TABLE hives
  ADD COLUMN sale_id uuid REFERENCES sales(id) ON DELETE SET NULL;
CREATE INDEX hives_sale_id_idx ON hives (sale_id) WHERE sale_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- 4. Feeders closed by a colony sale (reason sold_with_hive)
-- --------------------------------------------------------------------------

ALTER TABLE feedings
  ADD COLUMN sale_id uuid REFERENCES sales(id) ON DELETE SET NULL;
CREATE INDEX feedings_sale_id_idx ON feedings (sale_id) WHERE sale_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- 5. Equipment sold disposition + sale-linked returns
-- --------------------------------------------------------------------------

-- Postgres forbids using a new enum value in the transaction that adds it;
-- the application writes 'sold' after this migration commits.
ALTER TYPE stock_adjustment_reason ADD VALUE IF NOT EXISTS 'sold';

ALTER TABLE equipment_stock_adjustments
  ADD COLUMN sale_id uuid REFERENCES sales(id) ON DELETE SET NULL;
CREATE INDEX equipment_stock_adjustments_sale_idx
  ON equipment_stock_adjustments (sale_id) WHERE sale_id IS NOT NULL;

ALTER TABLE equipment_deployment_returns
  DROP CONSTRAINT IF EXISTS equipment_deployment_returns_reason_check;
ALTER TABLE equipment_deployment_returns
  ADD CONSTRAINT equipment_deployment_returns_reason_check CHECK (reason IN (
    'season_end', 'no_longer_needed', 'maintenance', 'damaged',
    'hive_removed', 'other', 'sold_with_hive'));

ALTER TABLE equipment_deployment_returns
  ADD COLUMN sale_id uuid REFERENCES sales(id) ON DELETE SET NULL;
CREATE INDEX equipment_deployment_returns_sale_idx
  ON equipment_deployment_returns (sale_id) WHERE sale_id IS NOT NULL;

-- +goose Down

DROP INDEX IF EXISTS equipment_deployment_returns_sale_idx;
ALTER TABLE equipment_deployment_returns DROP COLUMN IF EXISTS sale_id;
ALTER TABLE equipment_deployment_returns
  DROP CONSTRAINT IF EXISTS equipment_deployment_returns_reason_check;
ALTER TABLE equipment_deployment_returns
  ADD CONSTRAINT equipment_deployment_returns_reason_check CHECK (reason IN (
    'season_end', 'no_longer_needed', 'maintenance', 'damaged',
    'hive_removed', 'other'));

DROP INDEX IF EXISTS equipment_stock_adjustments_sale_idx;
ALTER TABLE equipment_stock_adjustments DROP COLUMN IF EXISTS sale_id;
-- 'sold' stays on stock_adjustment_reason (Postgres cannot drop an enum value).

DROP INDEX IF EXISTS feedings_sale_id_idx;
ALTER TABLE feedings DROP COLUMN IF EXISTS sale_id;

DROP INDEX IF EXISTS hives_sale_id_idx;
ALTER TABLE hives DROP COLUMN IF EXISTS sale_id;

DROP INDEX IF EXISTS sale_items_equipment_stock_id_idx;
DROP INDEX IF EXISTS sale_items_hive_id_idx;
ALTER TABLE sale_items
  DROP CONSTRAINT IF EXISTS sale_items_target_check,
  DROP CONSTRAINT IF EXISTS sale_items_kind_check,
  DROP COLUMN IF EXISTS equipment_stock_id,
  DROP COLUMN IF EXISTS hive_id,
  DROP COLUMN IF EXISTS kind;
ALTER TABLE sale_items ALTER COLUMN jar_size_id SET NOT NULL;

ALTER TABLE sale_items RENAME CONSTRAINT sale_items_pkey TO honey_sale_items_pkey;
ALTER TABLE sales RENAME CONSTRAINT sales_pkey TO honey_sales_pkey;

ALTER INDEX IF EXISTS sale_items_created_by_idx RENAME TO honey_sale_items_created_by_idx;
ALTER INDEX IF EXISTS sales_created_by_idx RENAME TO honey_sales_created_by_idx;
ALTER INDEX IF EXISTS sale_items_jar_size_id_idx RENAME TO honey_sale_items_jar_size_id_idx;
ALTER INDEX IF EXISTS sale_items_sale_id_idx RENAME TO honey_sale_items_sale_id_idx;
ALTER INDEX IF EXISTS sales_harvest_lot_idx RENAME TO honey_sales_harvest_lot_idx;
ALTER INDEX IF EXISTS sales_customer_idx RENAME TO honey_sales_customer_idx;
ALTER INDEX IF EXISTS sales_channel_date_idx RENAME TO honey_sales_channel_date_idx;
ALTER INDEX IF EXISTS sales_order_number_idx RENAME TO honey_sales_order_number_idx;
ALTER TABLE sale_items RENAME TO honey_sale_items;
ALTER TABLE sales RENAME TO honey_sales;
