-- +goose Up
-- Reservations are expressed in the canonical unit of the inventory item.
-- Most sale lines already carry that unit directly. Raw propolis is the one
-- exception: sale_items.quantity is packaged SKU units while propolis_raw is
-- measured in grams, so translate through product_catalog.net_grams.

DROP VIEW inventory_available;
DROP VIEW inventory_reservations;

CREATE VIEW inventory_reservations AS
SELECT CASE WHEN si.kind = 'propolis'
              THEN '00000000-0000-0000-0000-000000000102'::uuid
            ELSE si.item_id END AS item_id,
       CASE WHEN si.hive_id IS NOT NULL THEN deployed.id
            ELSE COALESCE(mapped.id, home.id) END AS location_id,
       si.inventory_lot_id AS lot_id,
       NULL::text AS condition,
       si.hive_id AS container_hive_id,
       SUM(CASE WHEN si.kind = 'propolis'
                  THEN si.quantity * COALESCE(pc.net_grams, 1)
                ELSE si.quantity END)::numeric(14,4) AS reserved
FROM sale_items si
JOIN sales s ON s.id = si.sale_id
CROSS JOIN (SELECT id FROM inventory_locations WHERE is_home) home
CROSS JOIN (SELECT id FROM inventory_locations WHERE kind = 'deployed') deployed
LEFT JOIN inventory_locations mapped
  ON mapped.source_type = 'stock_location' AND mapped.source_id = s.stock_location_id
LEFT JOIN product_catalog pc ON pc.id = si.product_id
WHERE s.physical_applied_at IS NULL AND s.order_status <> 'cancelled'
  AND (si.item_id IS NOT NULL OR si.kind = 'propolis')
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

-- +goose Down
DROP VIEW inventory_available;
DROP VIEW inventory_reservations;

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
