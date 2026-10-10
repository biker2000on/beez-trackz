-- +goose Up
-- The harvest lot (varietal) a jar line sells. Every honey sale names the lot
-- each jar line comes off, so the ledger draws from exactly that lot and the
-- receipt, Honey Story and lot profitability all know which harvest the jars
-- were. Before this the only per-line provenance was a bottling run, and the
-- sale-level harvest_lot_id could pin one lot for the whole sale at most.
-- Nullable: colony, equipment and catalog-product lines carry no harvest lot,
-- and sales recorded before this column existed never named one.
-- Both chains run this same file.
ALTER TABLE sale_items ADD COLUMN harvest_lot_id uuid REFERENCES harvest_lots(id) ON DELETE SET NULL;
ALTER TABLE sale_items ADD CONSTRAINT sale_items_harvest_lot_jar_only
  CHECK (harvest_lot_id IS NULL OR kind = 'jar');
CREATE INDEX sale_items_harvest_lot_id_idx ON sale_items (harvest_lot_id);

-- +goose Down
DROP INDEX IF EXISTS sale_items_harvest_lot_id_idx;
ALTER TABLE sale_items DROP CONSTRAINT IF EXISTS sale_items_harvest_lot_jar_only;
ALTER TABLE sale_items DROP COLUMN harvest_lot_id;
