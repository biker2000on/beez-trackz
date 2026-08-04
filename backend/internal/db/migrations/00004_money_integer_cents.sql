-- +goose Up
-- Money becomes integer cents (BIGINT) on every honey/commerce table, and every
-- one of those tables gains updated_at + created_by. Float dollars can never
-- net to zero against a fixed-point accounting ledger (gnucash-web), and a
-- 1e-13 artifact is enough to reject a valid payment.
--
-- Equipment tables are deliberately untouched: they are converted separately.
--
-- Conversion is deterministic: ROUND(value::numeric * 100). The cast to numeric
-- happens before multiplication so the rounding decision is made in exact
-- decimal arithmetic rather than on a binary float. ROUND(numeric) rounds half
-- away from zero, which matches the API's dollars -> cents parser.
--
-- Each column is added, backfilled, constrained, and only then is the float
-- column dropped, so a failure at any step aborts the whole transaction with
-- the original data intact. Dropping the old column also drops its inline
-- CHECK constraint, which is re-declared against the cents column.

-- honey_sales -----------------------------------------------------------
ALTER TABLE honey_sales
  ADD COLUMN total_amount_cents    bigint,
  ADD COLUMN discount_amount_cents bigint,
  ADD COLUMN amount_paid_cents     bigint,
  -- Reserved for future tax mapping; NULL means "no tax recorded", which is
  -- distinct from "tax of zero".
  ADD COLUMN tax_cents             bigint;

UPDATE honey_sales SET
  total_amount_cents    = ROUND(total_amount::numeric * 100)::bigint,
  discount_amount_cents = ROUND(discount_amount::numeric * 100)::bigint,
  amount_paid_cents     = ROUND(amount_paid::numeric * 100)::bigint;

ALTER TABLE honey_sales
  ALTER COLUMN total_amount_cents    SET NOT NULL,
  ALTER COLUMN discount_amount_cents SET NOT NULL,
  ALTER COLUMN discount_amount_cents SET DEFAULT 0,
  ALTER COLUMN amount_paid_cents     SET NOT NULL,
  ALTER COLUMN amount_paid_cents     SET DEFAULT 0,
  ADD CONSTRAINT honey_sales_discount_amount_cents_check CHECK (discount_amount_cents >= 0),
  ADD CONSTRAINT honey_sales_amount_paid_cents_check     CHECK (amount_paid_cents >= 0),
  ADD CONSTRAINT honey_sales_tax_cents_check             CHECK (tax_cents IS NULL OR tax_cents >= 0),
  DROP COLUMN total_amount,
  DROP COLUMN discount_amount,
  DROP COLUMN amount_paid;

-- honey_sale_items ------------------------------------------------------
ALTER TABLE honey_sale_items ADD COLUMN unit_price_cents bigint;
UPDATE honey_sale_items SET unit_price_cents = ROUND(unit_price::numeric * 100)::bigint;
ALTER TABLE honey_sale_items
  ALTER COLUMN unit_price_cents SET NOT NULL,
  ADD CONSTRAINT honey_sale_items_unit_price_cents_check CHECK (unit_price_cents >= 0),
  DROP COLUMN unit_price;

-- jar_sizes -------------------------------------------------------------
ALTER TABLE jar_sizes ADD COLUMN default_price_cents bigint;
UPDATE jar_sizes SET default_price_cents = ROUND(default_price::numeric * 100)::bigint
  WHERE default_price IS NOT NULL;
ALTER TABLE jar_sizes
  ADD CONSTRAINT jar_sizes_default_price_cents_check
    CHECK (default_price_cents IS NULL OR default_price_cents >= 0),
  DROP COLUMN default_price;

-- expenses --------------------------------------------------------------
ALTER TABLE expenses ADD COLUMN amount_cents bigint;
UPDATE expenses SET amount_cents = ROUND(amount::numeric * 100)::bigint;
ALTER TABLE expenses
  ALTER COLUMN amount_cents SET NOT NULL,
  ADD CONSTRAINT expenses_amount_cents_check CHECK (amount_cents >= 0),
  DROP COLUMN amount;

-- wholesale price lists -------------------------------------------------
ALTER TABLE wholesale_price_lists ADD COLUMN minimum_order_amount_cents bigint;
UPDATE wholesale_price_lists
  SET minimum_order_amount_cents = ROUND(minimum_order_amount::numeric * 100)::bigint;
ALTER TABLE wholesale_price_lists
  ALTER COLUMN minimum_order_amount_cents SET NOT NULL,
  ALTER COLUMN minimum_order_amount_cents SET DEFAULT 0,
  ADD CONSTRAINT wholesale_price_lists_minimum_cents_check
    CHECK (minimum_order_amount_cents >= 0),
  DROP COLUMN minimum_order_amount;

ALTER TABLE wholesale_price_list_items ADD COLUMN unit_price_cents bigint;
UPDATE wholesale_price_list_items SET unit_price_cents = ROUND(unit_price::numeric * 100)::bigint;
ALTER TABLE wholesale_price_list_items
  ALTER COLUMN unit_price_cents SET NOT NULL,
  ADD CONSTRAINT wholesale_price_list_items_unit_price_cents_check CHECK (unit_price_cents >= 0),
  DROP COLUMN unit_price;

-- updated_at + created_by on every honey/commerce/inventory table --------
-- created_by is nullable: rows that predate authentication have no actor and
-- inventing one would be worse than recording the gap.

-- +goose StatementBegin
DO $$
DECLARE
  target text;
  needs_updated_at text[] := ARRAY[
    'honey_sales', 'honey_sale_items', 'honey_movements', 'honey_harvests',
    'harvest_sessions', 'jar_sizes', 'expenses', 'bottling_runs',
    'wholesale_price_lists', 'wholesale_price_list_items'
  ];
  needs_created_by text[] := ARRAY[
    'honey_sales', 'honey_sale_items', 'honey_movements', 'honey_harvests',
    'harvest_sessions', 'jar_sizes', 'expenses', 'bottling_runs',
    'wholesale_price_lists', 'wholesale_price_list_items',
    'harvest_lots', 'customers'
  ];
BEGIN
  FOREACH target IN ARRAY needs_updated_at LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()',
      target);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_updated_at', target);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      target || '_updated_at', target);
  END LOOP;

  FOREACH target IN ARRAY needs_created_by LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES app_users(id) ON DELETE SET NULL',
      target);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I (created_by)',
      target || '_created_by_idx', target);
  END LOOP;
END
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DO $$
DECLARE
  target text;
  tables text[] := ARRAY[
    'honey_sales', 'honey_sale_items', 'honey_movements', 'honey_harvests',
    'harvest_sessions', 'jar_sizes', 'expenses', 'bottling_runs',
    'wholesale_price_lists', 'wholesale_price_list_items',
    'harvest_lots', 'customers'
  ];
BEGIN
  FOREACH target IN ARRAY tables LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', target || '_created_by_idx');
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS created_by', target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY[
    'honey_sales', 'honey_sale_items', 'honey_movements', 'honey_harvests',
    'harvest_sessions', 'jar_sizes', 'expenses', 'bottling_runs',
    'wholesale_price_lists', 'wholesale_price_list_items'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', target || '_updated_at', target);
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS updated_at', target);
  END LOOP;
END
$$;
-- +goose StatementEnd

ALTER TABLE wholesale_price_list_items ADD COLUMN unit_price double precision;
UPDATE wholesale_price_list_items SET unit_price = unit_price_cents / 100.0;
ALTER TABLE wholesale_price_list_items
  ALTER COLUMN unit_price SET NOT NULL,
  ADD CONSTRAINT wholesale_price_list_items_unit_price_check CHECK (unit_price >= 0),
  DROP COLUMN unit_price_cents;

ALTER TABLE wholesale_price_lists ADD COLUMN minimum_order_amount double precision;
UPDATE wholesale_price_lists SET minimum_order_amount = minimum_order_amount_cents / 100.0;
ALTER TABLE wholesale_price_lists
  ALTER COLUMN minimum_order_amount SET NOT NULL,
  ALTER COLUMN minimum_order_amount SET DEFAULT 0,
  DROP COLUMN minimum_order_amount_cents;

ALTER TABLE expenses ADD COLUMN amount double precision;
UPDATE expenses SET amount = amount_cents / 100.0;
ALTER TABLE expenses
  ALTER COLUMN amount SET NOT NULL,
  ADD CONSTRAINT expenses_amount_check CHECK (amount >= 0),
  DROP COLUMN amount_cents;

ALTER TABLE jar_sizes ADD COLUMN default_price double precision;
UPDATE jar_sizes SET default_price = default_price_cents / 100.0 WHERE default_price_cents IS NOT NULL;
ALTER TABLE jar_sizes DROP COLUMN default_price_cents;

ALTER TABLE honey_sale_items ADD COLUMN unit_price double precision;
UPDATE honey_sale_items SET unit_price = unit_price_cents / 100.0;
ALTER TABLE honey_sale_items
  ALTER COLUMN unit_price SET NOT NULL,
  DROP COLUMN unit_price_cents;

ALTER TABLE honey_sales
  ADD COLUMN total_amount double precision,
  ADD COLUMN discount_amount double precision,
  ADD COLUMN amount_paid double precision;
UPDATE honey_sales SET
  total_amount    = total_amount_cents / 100.0,
  discount_amount = discount_amount_cents / 100.0,
  amount_paid     = amount_paid_cents / 100.0;
ALTER TABLE honey_sales
  ALTER COLUMN total_amount SET NOT NULL,
  ALTER COLUMN discount_amount SET NOT NULL,
  ALTER COLUMN discount_amount SET DEFAULT 0,
  ALTER COLUMN amount_paid SET NOT NULL,
  ALTER COLUMN amount_paid SET DEFAULT 0,
  ADD CONSTRAINT honey_sales_discount_amount_check CHECK (discount_amount >= 0),
  ADD CONSTRAINT honey_sales_amount_paid_check CHECK (amount_paid >= 0),
  DROP COLUMN total_amount_cents,
  DROP COLUMN discount_amount_cents,
  DROP COLUMN amount_paid_cents,
  DROP COLUMN tax_cents;
