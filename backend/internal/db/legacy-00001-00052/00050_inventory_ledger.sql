-- +goose Up
-- Phase A of the inventory ledger. This migration is deliberately additive:
-- the legacy quantity tables remain in place until the Phase B reset.

CREATE TABLE inventory_item_kinds (
  kind text PRIMARY KEY,
  description text NOT NULL,
  unit_family text NOT NULL
);

CREATE TABLE inventory_location_kinds (
  kind text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE inventory_operation_kinds (
  kind text PRIMARY KEY,
  description text NOT NULL,
  sided text NOT NULL CHECK (sided IN ('one', 'paired', 'transform'))
);

CREATE TABLE inventory_conditions (
  condition text PRIMARY KEY,
  description text NOT NULL,
  sellable boolean NOT NULL
);

CREATE TABLE inventory_operation_reasons (
  reason text PRIMARY KEY,
  description text NOT NULL,
  applies_to_kinds text[] NOT NULL DEFAULT '{}'
);

INSERT INTO inventory_item_kinds (kind, description, unit_family) VALUES
  ('honey_bulk', 'Bulk honey', 'mass'),
  ('jar', 'Filled honey jar', 'count'),
  ('catalog_product', 'Finished catalog product', 'count'),
  ('propolis_raw', 'Raw propolis', 'mass'),
  ('equipment', 'Beekeeping equipment', 'count'),
  ('packaging', 'Packaging material', 'count');

INSERT INTO inventory_location_kinds (kind, description) VALUES
  ('site', 'Physical site'),
  ('storage_area', 'Storage area'),
  ('apiary', 'Apiary'),
  ('consignee', 'Consignment location'),
  ('in_transit', 'Goods in transit'),
  ('deployed', 'Virtual location for hive-deployed stock');

INSERT INTO inventory_operation_kinds (kind, description, sided) VALUES
  ('receive', 'Receipt into inventory', 'one'),
  ('opening_balance', 'Imported opening balance', 'one'),
  ('transfer', 'Location-to-location transfer', 'paired'),
  ('deploy', 'Deploy stock to a hive', 'paired'),
  ('return', 'Return stock from a hive', 'paired'),
  ('transform', 'Consume inputs and produce outputs', 'transform'),
  ('sale_consume', 'Physical sale consumption', 'one'),
  ('sale_return', 'Physical sale return', 'one'),
  ('shrink', 'Loss or other shrink', 'one'),
  ('count_adjust', 'Physical count adjustment', 'one'),
  ('condition_change', 'Move stock between conditions', 'paired'),
  ('reversal', 'Exact negation of an operation', 'paired');

INSERT INTO inventory_conditions (condition, description, sellable) VALUES
  ('serviceable', 'Available for service or sale', true),
  ('damaged', 'Damaged and unavailable for ordinary use', false),
  ('retired', 'Retired from service', false);

INSERT INTO inventory_operation_reasons (reason, description, applies_to_kinds) VALUES
  ('none', 'No additional reason applies', ARRAY['receive','opening_balance','transfer','deploy','return','transform','sale_consume','sale_return','reversal']),
  ('give_away', 'Given away', ARRAY['shrink']),
  ('loss', 'Lost or destroyed', ARRAY['shrink']),
  ('feeding', 'Consumed as bee feed', ARRAY['shrink','transform']),
  ('settlement_shrink', 'Consignee-reported shrink', ARRAY['shrink']),
  ('count', 'Physical count correction', ARRAY['count_adjust']),
  ('packaging_consumed_untraced', 'Packaging consumption without a traced BOM line', ARRAY['shrink','transform']),
  ('damage', 'Changed to damaged condition', ARRAY['condition_change']),
  ('retire', 'Changed to retired condition', ARRAY['condition_change']),
  ('repair', 'Returned to serviceable condition', ARRAY['condition_change']);

CREATE TABLE inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL REFERENCES inventory_item_kinds(kind),
  name text NOT NULL,
  canonical_unit text NOT NULL,
  quantity_scale smallint NOT NULL CHECK (quantity_scale BETWEEN 0 AND 4),
  lot_tracked boolean NOT NULL,
  condition_tracked boolean NOT NULL,
  container_tracked boolean NOT NULL,
  source_type text,
  source_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  CONSTRAINT inventory_items_source_pair CHECK ((source_type IS NULL) = (source_id IS NULL)),
  UNIQUE (source_type, source_id)
);
CREATE TRIGGER inventory_items_updated_at BEFORE UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO inventory_items
  (id, kind, name, canonical_unit, quantity_scale, lot_tracked, condition_tracked, container_tracked)
VALUES
  ('00000000-0000-0000-0000-000000000101', 'honey_bulk', 'Bulk honey', 'lb', 4, true, false, false),
  ('00000000-0000-0000-0000-000000000102', 'propolis_raw', 'Raw propolis', 'g', 4, true, false, false);

CREATE TABLE inventory_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL REFERENCES inventory_location_kinds(kind),
  name text NOT NULL,
  parent_id uuid REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  is_home boolean NOT NULL DEFAULT false,
  source_type text,
  source_id uuid,
  is_consignment boolean NOT NULL DEFAULT false,
  price_basis text NOT NULL DEFAULT 'retail' CHECK (price_basis IN ('retail', 'commission', 'wholesale_list')),
  commission_bps integer CHECK (commission_bps IS NULL OR (commission_bps >= 0 AND commission_bps <= 10000)),
  wholesale_price_list_id uuid REFERENCES wholesale_price_lists(id) ON DELETE SET NULL,
  settlement_cadence text NOT NULL DEFAULT 'monthly' CHECK (settlement_cadence IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'on_request')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  CONSTRAINT inventory_locations_source_pair CHECK ((source_type IS NULL) = (source_id IS NULL)),
  CONSTRAINT inventory_locations_basis_check CHECK (
    (price_basis = 'commission' AND commission_bps IS NOT NULL)
    OR (price_basis = 'wholesale_list' AND wholesale_price_list_id IS NOT NULL)
    OR price_basis = 'retail'
  ),
  CONSTRAINT inventory_locations_home_check CHECK (
    NOT is_home OR (NOT is_consignment AND source_type IS NULL AND price_basis = 'retail')
  ),
  UNIQUE (source_type, source_id)
);
CREATE TRIGGER inventory_locations_updated_at BEFORE UPDATE ON inventory_locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX inventory_locations_single_home_idx ON inventory_locations (is_home) WHERE is_home;
CREATE UNIQUE INDEX inventory_locations_single_deployed_idx ON inventory_locations (kind) WHERE kind = 'deployed';

INSERT INTO inventory_locations (id, kind, name, is_home)
VALUES ('00000000-0000-0000-0000-000000000201', 'site', 'Home', true);
INSERT INTO inventory_locations (id, kind, name)
VALUES ('00000000-0000-0000-0000-000000000202', 'deployed', 'Deployed');
INSERT INTO inventory_locations (kind, name, source_type, source_id)
SELECT 'apiary', a.name, 'apiary', a.id FROM apiaries a;
INSERT INTO inventory_locations
  (kind, name, source_type, source_id, is_consignment, price_basis,
   commission_bps, wholesale_price_list_id, settlement_cadence, is_active, created_at, updated_at, created_by)
SELECT 'consignee', sl.name, 'stock_location', sl.id, sl.is_consignment,
       sl.price_basis, sl.commission_bps, sl.wholesale_price_list_id,
       sl.settlement_cadence, sl.is_active, sl.created_at, sl.updated_at, sl.created_by
FROM stock_locations sl
WHERE sl.is_consignment AND sl.deleted_at IS NULL;

CREATE TABLE inventory_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  code text NOT NULL,
  source_type text,
  source_id uuid,
  attributes jsonb NOT NULL DEFAULT '{}',
  is_legacy_unassigned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  CONSTRAINT inventory_lots_source_pair CHECK ((source_type IS NULL) = (source_id IS NULL)),
  UNIQUE (item_id, code),
  UNIQUE (id, item_id)
);
CREATE TRIGGER inventory_lots_updated_at BEFORE UPDATE ON inventory_lots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE inventory_operations (
  id uuid PRIMARY KEY,
  kind text NOT NULL REFERENCES inventory_operation_kinds(kind),
  reason text NOT NULL REFERENCES inventory_operation_reasons(reason),
  occurred_at timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  reverses_operation_id uuid REFERENCES inventory_operations(id) ON DELETE RESTRICT,
  legacy_ref_type text,
  legacy_ref_id uuid,
  details jsonb NOT NULL DEFAULT '{}',
  provenance text NOT NULL DEFAULT 'recorded',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  CONSTRAINT inventory_operations_legacy_ref_pair CHECK ((legacy_ref_type IS NULL) = (legacy_ref_id IS NULL)),
  CONSTRAINT inventory_operations_provenance_check CHECK (provenance IN ('recorded', 'legacy-import', 'legacy-unattributed'))
);
CREATE UNIQUE INDEX inventory_operations_single_reversal
  ON inventory_operations (reverses_operation_id) WHERE reverses_operation_id IS NOT NULL;
CREATE INDEX inventory_operations_source_idx ON inventory_operations (source_type, source_id);
CREATE INDEX inventory_operations_occurred_idx ON inventory_operations (occurred_at DESC, id);

CREATE TABLE inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES inventory_operations(id) ON DELETE RESTRICT,
  line_no smallint NOT NULL CHECK (line_no > 0),
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  location_id uuid NOT NULL REFERENCES inventory_locations(id),
  lot_id uuid,
  condition text REFERENCES inventory_conditions(condition),
  container_hive_id uuid REFERENCES hives(id) ON DELETE SET NULL,
  quantity numeric(14,4) NOT NULL CHECK (quantity <> 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  UNIQUE (operation_id, line_no),
  FOREIGN KEY (lot_id, item_id) REFERENCES inventory_lots(id, item_id) ON DELETE RESTRICT
);
CREATE INDEX inventory_movements_tuple_idx
  ON inventory_movements (item_id, location_id, lot_id, condition, container_hive_id);

-- +goose StatementBegin
CREATE FUNCTION inventory_movement_scale_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE item_scale smallint;
BEGIN
  SELECT quantity_scale INTO item_scale FROM inventory_items WHERE id = NEW.item_id;
  IF item_scale IS NOT NULL AND NEW.quantity <> trunc(NEW.quantity, item_scale) THEN
    RAISE EXCEPTION 'quantity % exceeds item quantity scale %', NEW.quantity, item_scale
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_movement_scale_guard';
  END IF;
  RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER inventory_movement_scale_guard
  BEFORE INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION inventory_movement_scale_guard();

-- +goose StatementBegin
CREATE FUNCTION inventory_hive_delete_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM inventory_movements m
    WHERE m.container_hive_id = OLD.id
    GROUP BY m.item_id, m.location_id, m.lot_id, m.condition
    HAVING SUM(m.quantity) <> 0
  ) THEN
    RAISE EXCEPTION 'hive % has a nonzero deployed inventory balance', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'inventory_hive_delete_guard';
  END IF;
  RETURN OLD;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER inventory_hive_delete_guard
  BEFORE DELETE ON hives FOR EACH ROW EXECUTE FUNCTION inventory_hive_delete_guard();

CREATE TABLE inventory_boms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  output_item_id uuid NOT NULL REFERENCES inventory_items(id),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL
);
CREATE TRIGGER inventory_boms_updated_at BEFORE UPDATE ON inventory_boms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE inventory_bom_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_id uuid NOT NULL REFERENCES inventory_boms(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('input', 'output', 'byproduct', 'waste')),
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  quantity numeric(14,4) NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  UNIQUE (bom_id, role, item_id)
);
CREATE TRIGGER inventory_bom_lines_updated_at BEFORE UPDATE ON inventory_bom_lines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE inventory_balance_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES inventory_items(id),
  location_id uuid NOT NULL REFERENCES inventory_locations(id),
  lot_id uuid REFERENCES inventory_lots(id),
  condition text REFERENCES inventory_conditions(condition),
  container_hive_id uuid REFERENCES hives(id) ON DELETE SET NULL,
  as_of_operation_id uuid NOT NULL REFERENCES inventory_operations(id) ON DELETE RESTRICT,
  on_hand numeric(14,4) NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  FOREIGN KEY (lot_id, item_id) REFERENCES inventory_lots(id, item_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX inventory_balance_checkpoints_tuple_idx
  ON inventory_balance_checkpoints (item_id, location_id, lot_id, condition, container_hive_id) NULLS NOT DISTINCT;
CREATE TRIGGER inventory_balance_checkpoints_updated_at BEFORE UPDATE ON inventory_balance_checkpoints
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE VIEW inventory_balances AS
WITH checkpoint_delta AS (
  SELECT c.item_id, c.location_id, c.lot_id, c.condition, c.container_hive_id,
         c.on_hand + COALESCE(SUM(m.quantity) FILTER (WHERE
           o.created_at > anchor.created_at OR
           (o.created_at = anchor.created_at AND o.id > anchor.id)), 0) AS on_hand
  FROM inventory_balance_checkpoints c
  JOIN inventory_operations anchor ON anchor.id = c.as_of_operation_id
  LEFT JOIN inventory_movements m
    ON m.item_id = c.item_id AND m.location_id = c.location_id
   AND m.lot_id IS NOT DISTINCT FROM c.lot_id
   AND m.condition IS NOT DISTINCT FROM c.condition
   AND m.container_hive_id IS NOT DISTINCT FROM c.container_hive_id
  LEFT JOIN inventory_operations o ON o.id = m.operation_id
  GROUP BY c.id, anchor.created_at, anchor.id
), raw_without_checkpoint AS (
  SELECT m.item_id, m.location_id, m.lot_id, m.condition, m.container_hive_id,
         SUM(m.quantity) AS on_hand
  FROM inventory_movements m
  WHERE NOT EXISTS (
    SELECT 1 FROM inventory_balance_checkpoints c
    WHERE c.item_id = m.item_id AND c.location_id = m.location_id
      AND c.lot_id IS NOT DISTINCT FROM m.lot_id
      AND c.condition IS NOT DISTINCT FROM m.condition
      AND c.container_hive_id IS NOT DISTINCT FROM m.container_hive_id
  )
  GROUP BY 1,2,3,4,5
)
SELECT * FROM checkpoint_delta
UNION ALL
SELECT * FROM raw_without_checkpoint;

ALTER TABLE sale_items
  ADD COLUMN item_id uuid REFERENCES inventory_items(id) ON DELETE RESTRICT,
  ADD COLUMN inventory_lot_id uuid REFERENCES inventory_lots(id) ON DELETE RESTRICT;
CREATE INDEX sale_items_inventory_item_idx ON sale_items (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX sale_items_inventory_lot_idx ON sale_items (inventory_lot_id) WHERE inventory_lot_id IS NOT NULL;

CREATE VIEW inventory_reservations AS
SELECT si.item_id,
       CASE WHEN si.hive_id IS NOT NULL THEN deployed.id
            ELSE COALESCE(mapped.id, home.id) END AS location_id,
       si.inventory_lot_id AS lot_id,
       NULL::text AS condition,
       si.hive_id AS container_hive_id,
       SUM(si.quantity)::numeric(14,4) AS reserved
FROM sale_items si
JOIN sales s ON s.id = si.sale_id
CROSS JOIN (SELECT id FROM inventory_locations WHERE is_home) home
CROSS JOIN (SELECT id FROM inventory_locations WHERE kind = 'deployed') deployed
LEFT JOIN inventory_locations mapped
  ON mapped.source_type = 'stock_location' AND mapped.source_id = s.stock_location_id
WHERE s.physical_applied_at IS NULL AND s.order_status <> 'cancelled'
  AND si.item_id IS NOT NULL
GROUP BY 1,2,3,4,5;

CREATE VIEW inventory_available AS
WITH keys AS (
  SELECT item_id, location_id, lot_id, condition, container_hive_id FROM inventory_balances
  UNION
  SELECT item_id, location_id, lot_id, condition, container_hive_id FROM inventory_reservations
)
SELECT k.item_id, k.location_id, k.lot_id, k.condition, k.container_hive_id,
       COALESCE(b.on_hand, 0)::numeric(14,4) AS on_hand,
       COALESCE(r.reserved, 0)::numeric(14,4) AS reserved,
       (COALESCE(b.on_hand, 0) - COALESCE(r.reserved, 0))::numeric(14,4) AS available
FROM keys k
LEFT JOIN inventory_balances b
  ON b.item_id = k.item_id AND b.location_id = k.location_id
 AND b.lot_id IS NOT DISTINCT FROM k.lot_id
 AND b.condition IS NOT DISTINCT FROM k.condition
 AND b.container_hive_id IS NOT DISTINCT FROM k.container_hive_id
LEFT JOIN inventory_reservations r
  ON r.item_id = k.item_id AND r.location_id = k.location_id
 AND r.lot_id IS NOT DISTINCT FROM k.lot_id
 AND r.condition IS NOT DISTINCT FROM k.condition
 AND r.container_hive_id IS NOT DISTINCT FROM k.container_hive_id;

ALTER TABLE jar_sizes ADD COLUMN item_id uuid REFERENCES inventory_items(id) ON DELETE RESTRICT;
ALTER TABLE product_catalog ADD COLUMN item_id uuid REFERENCES inventory_items(id) ON DELETE RESTRICT;
ALTER TABLE equipment_types
  ADD COLUMN item_id uuid REFERENCES inventory_items(id) ON DELETE RESTRICT,
  ADD COLUMN unit_cost_cents integer,
  ADD COLUMN needed_quantity integer,
  ADD COLUMN storage_location text,
  ADD COLUMN first_deployed_year integer;
ALTER TABLE harvest_lots ADD COLUMN inventory_lot_id uuid REFERENCES inventory_lots(id) ON DELETE RESTRICT;
ALTER TABLE product_batches ADD COLUMN inventory_lot_id uuid REFERENCES inventory_lots(id) ON DELETE RESTRICT;

-- +goose Down
ALTER TABLE product_batches DROP COLUMN IF EXISTS inventory_lot_id;
ALTER TABLE harvest_lots DROP COLUMN IF EXISTS inventory_lot_id;
ALTER TABLE equipment_types
  DROP COLUMN IF EXISTS first_deployed_year,
  DROP COLUMN IF EXISTS storage_location,
  DROP COLUMN IF EXISTS needed_quantity,
  DROP COLUMN IF EXISTS unit_cost_cents,
  DROP COLUMN IF EXISTS item_id;
ALTER TABLE product_catalog DROP COLUMN IF EXISTS item_id;
ALTER TABLE jar_sizes DROP COLUMN IF EXISTS item_id;
DROP VIEW IF EXISTS inventory_available;
DROP VIEW IF EXISTS inventory_reservations;
DROP INDEX IF EXISTS sale_items_inventory_lot_idx;
DROP INDEX IF EXISTS sale_items_inventory_item_idx;
ALTER TABLE sale_items DROP COLUMN IF EXISTS inventory_lot_id, DROP COLUMN IF EXISTS item_id;
DROP VIEW IF EXISTS inventory_balances;
DROP TABLE IF EXISTS inventory_balance_checkpoints;
DROP TABLE IF EXISTS inventory_bom_lines;
DROP TABLE IF EXISTS inventory_boms;
DROP TRIGGER IF EXISTS inventory_hive_delete_guard ON hives;
DROP FUNCTION IF EXISTS inventory_hive_delete_guard();
DROP TRIGGER IF EXISTS inventory_movement_scale_guard ON inventory_movements;
DROP FUNCTION IF EXISTS inventory_movement_scale_guard();
DROP TABLE IF EXISTS inventory_movements;
DROP TABLE IF EXISTS inventory_operations;
DROP TABLE IF EXISTS inventory_lots;
DROP TABLE IF EXISTS inventory_locations;
DROP TABLE IF EXISTS inventory_items;
DROP TABLE IF EXISTS inventory_operation_reasons;
DROP TABLE IF EXISTS inventory_conditions;
DROP TABLE IF EXISTS inventory_operation_kinds;
DROP TABLE IF EXISTS inventory_location_kinds;
DROP TABLE IF EXISTS inventory_item_kinds;
