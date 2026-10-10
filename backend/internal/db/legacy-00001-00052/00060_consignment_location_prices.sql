-- +goose Up
-- Per-store prices for consignment. A wholesale store buys at the operator's
-- price per jar ("my wholesale price to them") and puts it on its own shelf at
-- whatever it likes; both numbers belong to the store, not to the SKU or to a
-- shared price list. One row per (store, SKU): a jar size or a catalog
-- product, never both. Either price may be unset — a row with neither is
-- simply not written. Settlement freezes the resulting prices into sale_items,
-- so changing a row affects only reports recorded after it.
-- Both chains run this same file.
CREATE TABLE consignment_location_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  jar_size_id uuid REFERENCES jar_sizes(id) ON DELETE CASCADE,
  product_id uuid REFERENCES product_catalog(id) ON DELETE CASCADE,
  wholesale_price_cents bigint CHECK (wholesale_price_cents IS NULL OR wholesale_price_cents >= 0),
  shelf_price_cents bigint CHECK (shelf_price_cents IS NULL OR shelf_price_cents >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  CONSTRAINT consignment_location_prices_one_sku CHECK ((jar_size_id IS NULL) <> (product_id IS NULL))
);

CREATE UNIQUE INDEX consignment_location_prices_location_jar_key
  ON consignment_location_prices (location_id, jar_size_id) WHERE jar_size_id IS NOT NULL;
CREATE UNIQUE INDEX consignment_location_prices_location_product_key
  ON consignment_location_prices (location_id, product_id) WHERE product_id IS NOT NULL;
CREATE INDEX consignment_location_prices_jar_size_id_idx
  ON consignment_location_prices (jar_size_id);
CREATE INDEX consignment_location_prices_product_id_idx
  ON consignment_location_prices (product_id);
CREATE INDEX consignment_location_prices_created_by_idx
  ON consignment_location_prices (created_by);

CREATE TRIGGER consignment_location_prices_updated_at BEFORE UPDATE ON consignment_location_prices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +goose Down
DROP TRIGGER IF EXISTS consignment_location_prices_updated_at ON consignment_location_prices;
DROP TABLE consignment_location_prices;
