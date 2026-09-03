-- +goose Up
-- The bill of materials moves onto the ledger tables (spec 3.6, 12.1 open
-- item 8). inventory_boms / inventory_bom_lines are now the authority the
-- equipment BOM editor writes and assembly reads; equipment_type_components
-- stays as a mirror until Phase B drops it.
--
-- Two things have to follow the authority here rather than in application code
-- alone:
--
--   1. The cycle guard. Migration 00046 put it on equipment_type_components,
--      the table Phase B drops, so the same rule is installed on
--      inventory_bom_lines and is carried into 00001_baseline.sql. The
--      application walks the graph itself before writing (app/equipment/bom.go)
--      and returns a typed refusal; this trigger is the floor under that, for
--      the writes the application never sees.
--   2. The existing recipes. A Phase A database already holds
--      equipment_type_components rows and, for a type nothing has moved yet,
--      may hold no inventory item for them at all. Seeding once here is what
--      lets the new reads answer for data that predates them; the shape is
--      exactly app/backfill's mirror, so a later backfill finds its own rows
--      and changes nothing.

-- +goose StatementBegin
CREATE FUNCTION inventory_bom_cycle_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role <> 'input' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestry AS (
      SELECT b.output_item_id AS item_id
      FROM inventory_boms b WHERE b.id = NEW.bom_id
      UNION
      SELECT b.output_item_id
      FROM inventory_bom_lines l
      JOIN inventory_boms b ON b.id = l.bom_id
      JOIN ancestry a ON a.item_id = l.item_id
      WHERE l.role = 'input'
    )
    SELECT 1 FROM ancestry WHERE item_id = NEW.item_id
  ) THEN
    RAISE EXCEPTION 'bill-of-materials input % would create a cycle', NEW.item_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER inventory_bom_lines_cycle_guard
  BEFORE INSERT OR UPDATE ON inventory_bom_lines
  FOR EACH ROW EXECUTE FUNCTION inventory_bom_cycle_guard();

-- Seed, once: every catalog type that takes part in a recipe needs the
-- inventory identity the ledger BOM is keyed on. The columns are EnsureItem's
-- (app/equipment/catalog.go) — a frame type defaults to its fresh identity,
-- packaging is its own kind — so the row this creates is the row EnsureItem
-- would have created, and its ON CONFLICT (source_type, source_id) DO UPDATE
-- finds it later.
INSERT INTO inventory_items
  (kind, name, canonical_unit, quantity_scale,
   lot_tracked, condition_tracked, container_tracked, source_type, source_id)
SELECT CASE WHEN et.category = 'packaging' THEN 'packaging' ELSE 'equipment' END,
       CASE WHEN et.category = 'frame' THEN et.name || ', fresh' ELSE et.name END,
       'count', 0, false, true, true,
       CASE WHEN et.category = 'frame' THEN 'equipment_type_frame_fresh'
            ELSE 'equipment_type' END,
       et.id
FROM equipment_types et
WHERE et.item_id IS NULL
  AND EXISTS (SELECT 1 FROM equipment_type_components c
              WHERE c.parent_type_id = et.id OR c.component_type_id = et.id)
ON CONFLICT (source_type, source_id) DO NOTHING;

-- The singular catalog link, chosen the same way EnsureItem's COALESCE would:
-- whatever identity already exists, and only for the types above.
UPDATE equipment_types et
SET item_id = (
      SELECT ii.id FROM inventory_items ii
      WHERE ii.source_id = et.id
        AND ii.source_type IN ('equipment_type',
                               'equipment_type_frame_drawn',
                               'equipment_type_frame_fresh')
      ORDER BY ii.source_type
      LIMIT 1)
WHERE et.item_id IS NULL
  AND EXISTS (SELECT 1 FROM equipment_type_components c
              WHERE c.parent_type_id = et.id OR c.component_type_id = et.id);

-- The recipes themselves, in app/backfill's exact shape.
INSERT INTO inventory_boms (name, output_item_id)
SELECT et.name, et.item_id FROM equipment_types et
WHERE et.item_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM equipment_type_components c WHERE c.parent_type_id = et.id)
  AND NOT EXISTS (SELECT 1 FROM inventory_boms b WHERE b.output_item_id = et.item_id);

INSERT INTO inventory_bom_lines (bom_id, role, item_id, quantity)
SELECT b.id, 'input', ct.item_id, c.quantity
FROM equipment_type_components c
JOIN equipment_types pt ON pt.id = c.parent_type_id
JOIN inventory_boms b ON b.output_item_id = pt.item_id
JOIN equipment_types ct ON ct.id = c.component_type_id
WHERE ct.item_id IS NOT NULL
ON CONFLICT (bom_id, role, item_id) DO UPDATE SET quantity = EXCLUDED.quantity;

-- +goose Down
DROP TRIGGER IF EXISTS inventory_bom_lines_cycle_guard ON inventory_bom_lines;
DROP FUNCTION IF EXISTS inventory_bom_cycle_guard();
-- The seeded BOM rows are left in place: they are the same rows app/backfill
-- writes, and deleting them would discard an operator's later edits.
