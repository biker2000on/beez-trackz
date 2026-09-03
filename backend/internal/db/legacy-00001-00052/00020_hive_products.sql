-- +goose Up
-- Other hive products on the same sale spine. Extend sale_items.kind and
-- add a small finished-SKU catalog, propolis harvests (not honey), and
-- conversion batches that write honey_movements so bulk honey still
-- answers "where did this honey go".

-- --------------------------------------------------------------------------
-- 1. Product catalog (finished SKUs; not a second jar_sizes)
-- --------------------------------------------------------------------------

CREATE TABLE product_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'creamed_honey', 'hot_honey', 'mead', 'propolis', 'tincture')),
  unit text NOT NULL,
  default_price_cents bigint NOT NULL CHECK (default_price_cents >= 0),
  size_label text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL
);
CREATE TRIGGER product_catalog_updated_at BEFORE UPDATE ON product_catalog
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX product_catalog_kind_idx ON product_catalog (kind);
CREATE INDEX product_catalog_created_by_idx ON product_catalog (created_by);
CREATE UNIQUE INDEX product_catalog_name_kind_size_idx
  ON product_catalog (lower(name), kind, COALESCE(size_label, ''));

-- --------------------------------------------------------------------------
-- 2. Propolis harvest — hive or yard, grams or ounces. Never honey lbs.
-- --------------------------------------------------------------------------

CREATE TABLE propolis_harvests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid REFERENCES hives(id),
  apiary_id uuid REFERENCES apiaries(id),
  date timestamptz NOT NULL,
  amount double precision NOT NULL CHECK (amount > 0),
  unit text NOT NULL CHECK (unit IN ('grams', 'ounces')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  CONSTRAINT propolis_harvests_source_check CHECK (
    hive_id IS NOT NULL OR apiary_id IS NOT NULL
  )
);
CREATE TRIGGER propolis_harvests_updated_at BEFORE UPDATE ON propolis_harvests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX propolis_harvests_hive_idx ON propolis_harvests (hive_id)
  WHERE hive_id IS NOT NULL;
CREATE INDEX propolis_harvests_apiary_idx ON propolis_harvests (apiary_id)
  WHERE apiary_id IS NOT NULL;
CREATE INDEX propolis_harvests_date_idx ON propolis_harvests (date DESC);
CREATE INDEX propolis_harvests_live_idx ON propolis_harvests (date DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX propolis_harvests_created_by_idx ON propolis_harvests (created_by);

-- --------------------------------------------------------------------------
-- 3. Conversion batches (creamed / hot honey / mead / tincture)
-- --------------------------------------------------------------------------

CREATE TABLE product_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN (
    'creamed_honey', 'hot_honey', 'mead', 'tincture')),
  product_id uuid NOT NULL REFERENCES product_catalog(id),
  harvest_lot_id uuid REFERENCES harvest_lots(id),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  honey_lbs double precision CHECK (honey_lbs IS NULL OR honey_lbs >= 0),
  water_liters double precision CHECK (water_liters IS NULL OR water_liters >= 0),
  yeast text,
  vessel text,
  propolis_harvest_id uuid REFERENCES propolis_harvests(id),
  propolis_amount double precision CHECK (propolis_amount IS NULL OR propolis_amount >= 0),
  propolis_unit text CHECK (
    propolis_unit IS NULL OR propolis_unit IN ('grams', 'ounces')),
  quantity_out integer NOT NULL CHECK (quantity_out > 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  CONSTRAINT product_batches_honey_inputs_check CHECK (
    (kind IN ('creamed_honey', 'hot_honey', 'mead')
      AND honey_lbs IS NOT NULL AND honey_lbs > 0
      AND propolis_harvest_id IS NULL
      AND propolis_amount IS NULL)
    OR (kind = 'tincture'
      AND honey_lbs IS NULL
      AND propolis_harvest_id IS NOT NULL
      AND propolis_amount IS NOT NULL
      AND propolis_amount > 0
      AND propolis_unit IS NOT NULL)
  ),
  CONSTRAINT product_batches_creamed_lot_check CHECK (
    kind <> 'creamed_honey' OR harvest_lot_id IS NOT NULL
  )
);
CREATE TRIGGER product_batches_updated_at BEFORE UPDATE ON product_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX product_batches_product_idx ON product_batches (product_id);
CREATE INDEX product_batches_lot_idx ON product_batches (harvest_lot_id)
  WHERE harvest_lot_id IS NOT NULL;
CREATE INDEX product_batches_propolis_idx ON product_batches (propolis_harvest_id)
  WHERE propolis_harvest_id IS NOT NULL;
CREATE INDEX product_batches_kind_started_idx ON product_batches (kind, started_at DESC);
CREATE INDEX product_batches_created_by_idx ON product_batches (created_by);

CREATE TABLE product_batch_expenses (
  batch_id uuid NOT NULL REFERENCES product_batches(id) ON DELETE CASCADE,
  expense_id uuid NOT NULL REFERENCES expenses(id) ON DELETE RESTRICT,
  PRIMARY KEY (batch_id, expense_id)
);
CREATE INDEX product_batch_expenses_expense_idx ON product_batch_expenses (expense_id);

-- Link the honey movement that consumed bulk lbs for a batch. Written after
-- the batch row so the ledger can name the SKU and lot.
ALTER TABLE honey_movements
  ADD COLUMN product_batch_id uuid REFERENCES product_batches(id) ON DELETE RESTRICT;
CREATE INDEX honey_movements_product_batch_idx
  ON honey_movements (product_batch_id) WHERE product_batch_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- 4. Sale lines: catalog kinds + product_id target
-- --------------------------------------------------------------------------

ALTER TABLE sale_items
  ADD COLUMN product_id uuid REFERENCES product_catalog(id);
CREATE INDEX sale_items_product_id_idx ON sale_items (product_id)
  WHERE product_id IS NOT NULL;

ALTER TABLE sale_items DROP CONSTRAINT IF EXISTS sale_items_kind_check;
ALTER TABLE sale_items DROP CONSTRAINT IF EXISTS sale_items_target_check;

ALTER TABLE sale_items
  ADD CONSTRAINT sale_items_kind_check CHECK (kind IN (
    'jar', 'colony', 'equipment',
    'creamed_honey', 'hot_honey', 'mead', 'propolis', 'tincture')),
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

-- Grocery inputs for hot honey / tincture / mead. Existing 'other' still works.
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_category_check;
ALTER TABLE expenses
  ADD CONSTRAINT expenses_category_check CHECK (category IN (
    'bees_queens', 'feed', 'treatments', 'packaging', 'equipment',
    'mileage', 'market_fees', 'labor', 'other', 'grocery'));

-- +goose Down

UPDATE expenses SET category = 'other' WHERE category = 'grocery';
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_category_check;
ALTER TABLE expenses
  ADD CONSTRAINT expenses_category_check CHECK (category IN (
    'bees_queens', 'feed', 'treatments', 'packaging', 'equipment',
    'mileage', 'market_fees', 'labor', 'other'));

DELETE FROM sale_items WHERE kind IN (
  'creamed_honey', 'hot_honey', 'mead', 'propolis', 'tincture');

ALTER TABLE sale_items DROP CONSTRAINT IF EXISTS sale_items_target_check;
ALTER TABLE sale_items DROP CONSTRAINT IF EXISTS sale_items_kind_check;
DROP INDEX IF EXISTS sale_items_product_id_idx;
ALTER TABLE sale_items DROP COLUMN IF EXISTS product_id;

ALTER TABLE sale_items
  ADD CONSTRAINT sale_items_kind_check
    CHECK (kind IN ('jar', 'colony', 'equipment')),
  ADD CONSTRAINT sale_items_target_check CHECK (
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

DELETE FROM honey_movements WHERE product_batch_id IS NOT NULL;
DROP INDEX IF EXISTS honey_movements_product_batch_idx;
ALTER TABLE honey_movements DROP COLUMN IF EXISTS product_batch_id;

DROP TABLE IF EXISTS product_batch_expenses;
DROP TABLE IF EXISTS product_batches;
DROP TABLE IF EXISTS propolis_harvests;
DROP TABLE IF EXISTS product_catalog;
