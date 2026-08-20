-- +goose Up
-- Inventory at more than one location (consignment at the bike shop).
--
-- Finished goods (jar sizes and product_catalog SKUs) now travel. Handing 24
-- jars to the shop is neither a sale nor shrink, so it needs a movement of its
-- own that touches no revenue, no COGS, and no pounds bottled.
--
-- HOME IS THE RESIDUAL, NOT A SEEDED PILE OF ROWS. The existing ledger
-- (honey_movements + product_batches + sale_items) already answers "how many
-- of this SKU exist"; this migration only records how many of them are
-- somewhere other than home. So:
--
--   onHand(L)    = SUM(stock_movements.quantity AT L) - sold on sales scoped to L
--   onHand(home) = globalOnHand - SUM(onHand(L)) over every non-home L
--
-- Every jar that exists today is therefore already seeded at home, with no
-- backfill and no second ledger that can drift from the first. The one rule
-- this buys: shrink discovered at a consignment location writes BOTH a
-- stock_movements adjustment there (so the shop's shelf is short) AND the
-- usual global honey_movements jar_adjustment (so the jar leaves the world) --
-- otherwise home would silently absorb the loss.

-- --------------------------------------------------------------------------
-- 1. Stock locations
-- --------------------------------------------------------------------------

CREATE TABLE stock_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  -- Deliberately not jar-only in name: used boxes through the shop are out of
  -- scope until they happen, but the table should not have to be renamed.
  is_home boolean NOT NULL DEFAULT false,
  is_consignment boolean NOT NULL DEFAULT false,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  -- How the operator gets paid for what sells here.
  --   retail          - the shop remits the full sale price (no cut)
  --   commission      - the shop keeps commission_bps of the sale price
  --   wholesale_list  - the operator is owed the wholesale list price per SKU
  price_basis text NOT NULL DEFAULT 'retail' CHECK (
    price_basis IN ('retail', 'commission', 'wholesale_list')
  ),
  -- Basis points, so the commission split stays exact integer arithmetic in
  -- the same spirit as integer cents. 3000 = 30%.
  commission_bps integer CHECK (
    commission_bps IS NULL OR (commission_bps >= 0 AND commission_bps <= 10000)
  ),
  wholesale_price_list_id uuid REFERENCES wholesale_price_lists(id) ON DELETE SET NULL,
  settlement_cadence text NOT NULL DEFAULT 'monthly' CHECK (
    settlement_cadence IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'on_request')
  ),
  address text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  CONSTRAINT stock_locations_basis_check CHECK (
    (price_basis = 'commission' AND commission_bps IS NOT NULL)
    OR (price_basis = 'wholesale_list' AND wholesale_price_list_id IS NOT NULL)
    OR price_basis = 'retail'
  ),
  -- Home is the operator's own stock; it is never consigned to anyone.
  CONSTRAINT stock_locations_home_check CHECK (
    NOT is_home OR (NOT is_consignment AND customer_id IS NULL
                    AND price_basis = 'retail' AND deleted_at IS NULL)
  )
);
CREATE TRIGGER stock_locations_updated_at BEFORE UPDATE ON stock_locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX stock_locations_single_home_idx ON stock_locations (is_home)
  WHERE is_home;
CREATE INDEX stock_locations_customer_idx ON stock_locations (customer_id)
  WHERE customer_id IS NOT NULL;
CREATE INDEX stock_locations_live_idx ON stock_locations (name)
  WHERE deleted_at IS NULL;
CREATE INDEX stock_locations_created_by_idx ON stock_locations (created_by);

COMMENT ON TABLE stock_locations IS
  'Where finished goods physically sit. Exactly one row is is_home; every quantity not accounted for by a stock_movements row is at home.';

-- The home row. The application re-creates it on demand (ON CONFLICT (slug))
-- so a truncated test database still resolves home without a migration.
INSERT INTO stock_locations (name, slug, is_home, notes)
VALUES ('Home', 'home', true, 'Default location for everything bottled or made.')
ON CONFLICT (slug) DO NOTHING;

-- --------------------------------------------------------------------------
-- 2. Settlement statements (created before stock_movements: movements point
--    at the settlement that produced them)
-- --------------------------------------------------------------------------

CREATE TABLE consignment_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,
  period_start date NOT NULL,
  period_end date NOT NULL,
  reported_at timestamptz NOT NULL,
  -- The sale that recognises revenue for what the shop reported sold. NULL
  -- when the report was pure returns/shrink with nothing sold.
  sale_id uuid REFERENCES sales(id) ON DELETE SET NULL,
  -- Owed = what the operator's share of the reported sales comes to;
  -- commission is the shop's cut, already excluded from owed.
  amount_owed_cents bigint NOT NULL DEFAULT 0 CHECK (amount_owed_cents >= 0),
  amount_paid_cents bigint NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  commission_cents bigint NOT NULL DEFAULT 0 CHECK (commission_cents >= 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  -- Soft, like a voided bottling run: the movements it wrote keep pointing here.
  voided_at timestamptz,
  voided_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  void_reason text,
  CONSTRAINT consignment_settlements_period_check CHECK (period_end >= period_start),
  CONSTRAINT consignment_settlements_paid_check CHECK (amount_paid_cents <= amount_owed_cents)
);
CREATE TRIGGER consignment_settlements_updated_at BEFORE UPDATE ON consignment_settlements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- One live statement per location per period; a voided one may be redone.
CREATE UNIQUE INDEX consignment_settlements_period_idx
  ON consignment_settlements (location_id, period_start, period_end)
  WHERE voided_at IS NULL;
CREATE INDEX consignment_settlements_location_idx
  ON consignment_settlements (location_id, period_end DESC);
CREATE INDEX consignment_settlements_sale_idx ON consignment_settlements (sale_id)
  WHERE sale_id IS NOT NULL;
CREATE INDEX consignment_settlements_created_by_idx
  ON consignment_settlements (created_by);

-- --------------------------------------------------------------------------
-- 3. Per-location finished-goods movements
-- --------------------------------------------------------------------------

CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date timestamptz NOT NULL,
  -- transfer   home -> location (the jars go on their shelf)
  -- return     location -> home (unsold jars come back); a reverse transfer
  -- adjustment single-sided shrink/found at one location
  kind text NOT NULL CHECK (kind IN ('transfer', 'return', 'adjustment')),
  location_id uuid NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,
  -- The other side of a transfer/return. Both rows share transfer_id and carry
  -- opposite quantities, so a location's net is a plain SUM.
  counterparty_location_id uuid REFERENCES stock_locations(id) ON DELETE RESTRICT,
  transfer_id uuid,
  -- Exactly one finished-goods SKU per row.
  jar_size_id uuid REFERENCES jar_sizes(id),
  product_id uuid REFERENCES product_catalog(id),
  quantity integer NOT NULL CHECK (quantity <> 0),
  -- Lot / batch ancestry travels with the jars, so Honey Story and "where did
  -- this honey go" still answer once stock is spread across locations.
  harvest_lot_id uuid REFERENCES harvest_lots(id) ON DELETE SET NULL,
  bottling_run_id uuid REFERENCES bottling_runs(id) ON DELETE RESTRICT,
  product_batch_id uuid REFERENCES product_batches(id) ON DELETE RESTRICT,
  sale_id uuid REFERENCES sales(id) ON DELETE SET NULL,
  settlement_id uuid REFERENCES consignment_settlements(id) ON DELETE SET NULL,
  -- Reversal, never deletion: the pair nets to zero and both rows survive.
  reverses_movement_id uuid REFERENCES stock_movements(id) ON DELETE RESTRICT,
  -- Replaying the same request must not move the stock twice.
  idempotency_key text,
  reason text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  CONSTRAINT stock_movements_sku_check CHECK (
    (jar_size_id IS NOT NULL) <> (product_id IS NOT NULL)
  ),
  CONSTRAINT stock_movements_pair_check CHECK (
    (kind IN ('transfer', 'return')
      AND transfer_id IS NOT NULL
      AND counterparty_location_id IS NOT NULL
      AND counterparty_location_id <> location_id)
    OR (kind = 'adjustment'
      AND transfer_id IS NULL
      AND counterparty_location_id IS NULL)
  )
);
CREATE INDEX stock_movements_location_date_idx
  ON stock_movements (location_id, date DESC);
CREATE INDEX stock_movements_jar_size_idx ON stock_movements (jar_size_id)
  WHERE jar_size_id IS NOT NULL;
CREATE INDEX stock_movements_product_idx ON stock_movements (product_id)
  WHERE product_id IS NOT NULL;
CREATE INDEX stock_movements_transfer_idx ON stock_movements (transfer_id)
  WHERE transfer_id IS NOT NULL;
CREATE INDEX stock_movements_lot_idx ON stock_movements (harvest_lot_id)
  WHERE harvest_lot_id IS NOT NULL;
CREATE INDEX stock_movements_settlement_idx ON stock_movements (settlement_id)
  WHERE settlement_id IS NOT NULL;
CREATE INDEX stock_movements_sale_idx ON stock_movements (sale_id)
  WHERE sale_id IS NOT NULL;
CREATE INDEX stock_movements_created_by_idx ON stock_movements (created_by);
CREATE UNIQUE INDEX stock_movements_reverses_idx
  ON stock_movements (reverses_movement_id)
  WHERE reverses_movement_id IS NOT NULL;
CREATE UNIQUE INDEX stock_movements_idempotency_idx
  ON stock_movements (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Shrink found at a consignment location has two halves: the location's shelf
-- is short (a stock_movements adjustment there) AND the jar has left the world
-- (the usual global jar_adjustment). Linking the global half back to the
-- settlement is what lets a void reverse both.
ALTER TABLE honey_movements
  ADD COLUMN settlement_id uuid REFERENCES consignment_settlements(id) ON DELETE SET NULL;
CREATE INDEX honey_movements_settlement_idx ON honey_movements (settlement_id)
  WHERE settlement_id IS NOT NULL;

COMMENT ON COLUMN stock_movements.quantity IS
  'Signed. A transfer writes -n at the source and +n at the destination; a reversal writes the negation of the row it reverses so the pair nets to zero.';

-- --------------------------------------------------------------------------
-- 4. Sales are location-scoped
-- --------------------------------------------------------------------------

-- NULL means home, which is what every existing sale was. A consignment sale
-- carries the shop's location so its lines decrement the shop's shelf and not
-- the operator's own stock. Revenue is recognised on this sale (the shop's
-- report), never on the transfer that put the jars there; the money is a
-- receivable until amount_paid_cents catches up with total_amount_cents.
ALTER TABLE sales
  ADD COLUMN stock_location_id uuid REFERENCES stock_locations(id) ON DELETE RESTRICT;
CREATE INDEX sales_stock_location_idx ON sales (stock_location_id)
  WHERE stock_location_id IS NOT NULL;
COMMENT ON COLUMN sales.stock_location_id IS
  'Location the sold stock came off. NULL = home.';

-- --------------------------------------------------------------------------
-- 5. Location dimension on the external accounting mappings
--
-- Designed now, not built: GnuCash sync is a separate roadmap item. Consigned
-- stock stays on the inventory account until the shop reports; the report
-- posts revenue + COGS + AR and the payment clears AR. Because the account a
-- SKU resolves to depends on where the stock sits, the mapping key has to
-- carry the location or consignment becomes a third mapping later.
-- --------------------------------------------------------------------------

ALTER TABLE external_sync
  ADD COLUMN location_id uuid REFERENCES stock_locations(id) ON DELETE CASCADE;
CREATE INDEX external_sync_location_idx ON external_sync (location_id)
  WHERE location_id IS NOT NULL;

ALTER TABLE external_sync DROP CONSTRAINT IF EXISTS external_sync_entity_type_check;
ALTER TABLE external_sync
  ADD CONSTRAINT external_sync_entity_type_check CHECK (
    entity_type IN (
      'honey_sale', 'honey_sale_item', 'expense', 'customer',
      'harvest_lot', 'jar_size', 'honey_movement', 'bottling_run',
      'stock_location', 'stock_movement', 'consignment_settlement'
    )
  );

-- One entity may map differently per location, so the identity key gains the
-- location. The all-NULL uuid stands in for "no location dimension".
DROP INDEX IF EXISTS external_sync_entity_idx;
CREATE UNIQUE INDEX external_sync_entity_idx ON external_sync (
  system, entity_type, entity_id,
  COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

-- +goose Down

DROP INDEX IF EXISTS external_sync_entity_idx;
DELETE FROM external_sync
  WHERE entity_type IN ('stock_location', 'stock_movement', 'consignment_settlement');
CREATE UNIQUE INDEX external_sync_entity_idx
  ON external_sync (system, entity_type, entity_id);
ALTER TABLE external_sync DROP CONSTRAINT IF EXISTS external_sync_entity_type_check;
ALTER TABLE external_sync
  ADD CONSTRAINT external_sync_entity_type_check CHECK (
    entity_type IN (
      'honey_sale', 'honey_sale_item', 'expense', 'customer',
      'harvest_lot', 'jar_size', 'honey_movement', 'bottling_run'
    )
  );
DROP INDEX IF EXISTS external_sync_location_idx;
ALTER TABLE external_sync DROP COLUMN IF EXISTS location_id;

DROP INDEX IF EXISTS sales_stock_location_idx;
ALTER TABLE sales DROP COLUMN IF EXISTS stock_location_id;

DROP INDEX IF EXISTS honey_movements_settlement_idx;
ALTER TABLE honey_movements DROP COLUMN IF EXISTS settlement_id;

DROP TABLE IF EXISTS stock_movements;
DROP TABLE IF EXISTS consignment_settlements;
DROP TABLE IF EXISTS stock_locations;
