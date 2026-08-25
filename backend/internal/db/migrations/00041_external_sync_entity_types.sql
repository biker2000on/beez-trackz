-- +goose Up
-- Rename pre-00015 spellings on external_sync.entity_type (honey_sale /
-- honey_sale_item -> sale / sale_item) and extend the allowlist for the
-- domains that have grown since 00005/00024. Unique indexes, including
-- the 00024 COALESCE(location_id, all-zero uuid) identity key, stay put.

UPDATE external_sync SET entity_type = 'sale' WHERE entity_type = 'honey_sale';
UPDATE external_sync SET entity_type = 'sale_item' WHERE entity_type = 'honey_sale_item';

ALTER TABLE external_sync DROP CONSTRAINT IF EXISTS external_sync_entity_type_check;
ALTER TABLE external_sync
  ADD CONSTRAINT external_sync_entity_type_check CHECK (
    entity_type IN (
      'sale', 'sale_item', 'expense', 'customer',
      'harvest_lot', 'jar_size', 'honey_movement', 'bottling_run',
      'stock_location', 'stock_movement', 'consignment_settlement',
      'hive', 'equipment_stock', 'equipment_stock_adjustment',
      'product_catalog', 'product_batch', 'product_adjustment'
    )
  );

-- +goose Down
DELETE FROM external_sync
  WHERE entity_type IN (
    'hive', 'equipment_stock', 'equipment_stock_adjustment',
    'product_catalog', 'product_batch', 'product_adjustment'
  );
UPDATE external_sync SET entity_type = 'honey_sale' WHERE entity_type = 'sale';
UPDATE external_sync SET entity_type = 'honey_sale_item' WHERE entity_type = 'sale_item';

ALTER TABLE external_sync DROP CONSTRAINT IF EXISTS external_sync_entity_type_check;
ALTER TABLE external_sync
  ADD CONSTRAINT external_sync_entity_type_check CHECK (
    entity_type IN (
      'honey_sale', 'honey_sale_item', 'expense', 'customer',
      'harvest_lot', 'jar_size', 'honey_movement', 'bottling_run',
      'stock_location', 'stock_movement', 'consignment_settlement'
    )
  );
