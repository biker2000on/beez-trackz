-- +goose Up
ALTER TABLE inventory_locations
  ADD COLUMN slug text,
  ADD COLUMN customer_id uuid REFERENCES customers(id),
  ADD COLUMN address text,
  ADD COLUMN notes text,
  ADD COLUMN deleted_at timestamptz;

CREATE UNIQUE INDEX inventory_locations_slug_idx
  ON inventory_locations (slug) WHERE slug IS NOT NULL;

UPDATE inventory_locations
SET slug = 'home'
WHERE id = '00000000-0000-0000-0000-000000000201';

-- +goose StatementBegin
DO $$
BEGIN
  IF to_regclass('public.stock_locations') IS NOT NULL THEN
    EXECUTE $backfill$
      UPDATE inventory_locations il
      SET slug = sl.slug,
          customer_id = sl.customer_id,
          address = sl.address,
          notes = sl.notes,
          deleted_at = sl.deleted_at
      FROM stock_locations sl
      WHERE il.source_type = 'stock_location'
        AND il.source_id = sl.id
    $backfill$;
  END IF;
END
$$;
-- +goose StatementEnd

-- The two surviving location references were foreign keys to stock_locations
-- on the legacy chain; the baseline never had them (unconstrained uuids).
-- Writers now store inventory_locations ids there, so the legacy chain must
-- match the baseline. No-ops where the constraint is already absent.
ALTER TABLE consignment_settlements DROP CONSTRAINT IF EXISTS consignment_settlements_location_id_fkey;
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_stock_location_id_fkey;
ALTER TABLE external_sync DROP CONSTRAINT IF EXISTS external_sync_location_id_fkey;

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

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF to_regclass('public.stock_locations') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE consignment_settlements ADD CONSTRAINT consignment_settlements_location_id_fkey FOREIGN KEY (location_id) REFERENCES stock_locations(id) ON DELETE RESTRICT NOT VALID';
    EXECUTE 'ALTER TABLE sales ADD CONSTRAINT sales_stock_location_id_fkey FOREIGN KEY (stock_location_id) REFERENCES stock_locations(id) ON DELETE RESTRICT NOT VALID';
    EXECUTE 'ALTER TABLE external_sync ADD CONSTRAINT external_sync_location_id_fkey FOREIGN KEY (location_id) REFERENCES stock_locations(id) ON DELETE CASCADE NOT VALID';
  END IF;
END
$$;
-- +goose StatementEnd
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
  ON mapped.source_type = 'stock_location' AND mapped.source_id = s.stock_location_id
LEFT JOIN product_catalog pc ON pc.id = si.product_id
WHERE s.physical_applied_at IS NULL AND s.order_status <> 'cancelled'
  AND (si.item_id IS NOT NULL OR si.kind = 'propolis')
GROUP BY 1,2,3,4,5;

DROP INDEX inventory_locations_slug_idx;
ALTER TABLE inventory_locations
  DROP COLUMN deleted_at,
  DROP COLUMN notes,
  DROP COLUMN address,
  DROP COLUMN customer_id,
  DROP COLUMN slug;
