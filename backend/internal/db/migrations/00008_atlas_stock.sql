-- +goose Up
ALTER TABLE harvest_sessions ADD COLUMN closed_at timestamptz;
-- Legacy sessions remain unclassified/open until an operator explicitly closes them.
-- Neither stock, weight, nor age establishes completion.
CREATE OR REPLACE VIEW inventory_reservations AS
SELECT CASE WHEN si.kind = 'propolis'
              THEN '00000000-0000-0000-0000-000000000102'::uuid
            ELSE si.item_id END AS item_id,
       CASE WHEN si.hive_id IS NOT NULL THEN deployed.id
            ELSE COALESCE(mapped.id, home.id) END AS location_id,
       si.inventory_lot_id AS lot_id,
       CASE WHEN si.kind='equipment' THEN 'serviceable'::text ELSE NULL::text END AS condition,
       si.hive_id AS container_hive_id,
       SUM(CASE WHEN si.kind = 'propolis'
                  THEN si.quantity * COALESCE(pc.net_grams, 1)
                ELSE si.quantity END)::numeric(14,4) AS reserved
FROM sale_items si
JOIN sales s ON s.id = si.sale_id
CROSS JOIN (SELECT id FROM inventory_locations WHERE is_home) home
CROSS JOIN (SELECT id FROM inventory_locations WHERE kind = 'deployed') deployed
LEFT JOIN inventory_locations mapped
  ON mapped.id = s.stock_location_id
  OR (mapped.source_type = 'stock_location' AND mapped.source_id = s.stock_location_id)
LEFT JOIN product_catalog pc ON pc.id = si.product_id
WHERE s.physical_applied_at IS NULL AND s.order_status <> 'cancelled'
  AND (si.item_id IS NOT NULL OR si.kind = 'propolis')
GROUP BY 1,2,3,4,5;


-- +goose Down
CREATE OR REPLACE VIEW inventory_reservations AS
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
  ON mapped.id = s.stock_location_id
  OR (mapped.source_type = 'stock_location' AND mapped.source_id = s.stock_location_id)
LEFT JOIN product_catalog pc ON pc.id = si.product_id
WHERE s.physical_applied_at IS NULL AND s.order_status <> 'cancelled'
  AND (si.item_id IS NOT NULL OR si.kind = 'propolis')
GROUP BY 1,2,3,4,5;


ALTER TABLE harvest_sessions DROP COLUMN closed_at;
