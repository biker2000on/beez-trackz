-- +goose Up
-- Catalog products get the two things jars already had: an adjustment ledger
-- and an undo.
--
-- 1. product_adjustments. A product_catalog SKU's on-hand was batches minus
--    sales and nothing else, so there was no way to say "one broke". The
--    settlement path felt it first: shrink counted at the bike shop is refused
--    with a 400 for catalog SKUs, because writing the shop's half alone would
--    hand the missing unit back to home as the residual. This is the missing
--    global half — jar shrink's honey_movements jar_adjustment, for products.
--
-- 2. product_batches void. A wrong 40 lb mead batch permanently consumed bulk
--    honey. Voiding is modelled on 00023's bottling-run void: soft, never a
--    delete, because honey_movements.product_batch_id is ON DELETE RESTRICT
--    and the reversing entries keep pointing at the batch.

-- --------------------------------------------------------------------------
-- 1. Product adjustment ledger
-- --------------------------------------------------------------------------

CREATE TABLE product_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES product_catalog(id) ON DELETE RESTRICT,
  date timestamptz NOT NULL,
  -- Signed, like honey_movements.quantity on a jar_adjustment: negative is
  -- shrink, positive is stock found. Zero would be a no-op record.
  delta integer NOT NULL CHECK (delta <> 0),
  reason text,
  notes text,
  -- Where the loss was discovered. The shelf half of a consignment shrink is
  -- the stock_movements adjustment at that location; this row is the global
  -- half (the unit left the world) and only names the place for the audit
  -- trail. NULL means home.
  location_id uuid REFERENCES stock_locations(id) ON DELETE RESTRICT,
  -- Set when a settlement wrote this row, so voiding the settlement can undo
  -- exactly what it wrote and nothing else.
  settlement_id uuid REFERENCES consignment_settlements(id) ON DELETE SET NULL,
  -- Replaying the same settlement or request must not shrink the stock twice.
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  -- Soft delete is this table's undo, the way it is for propolis_harvests.
  -- Every on-hand aggregate filters deleted_at IS NULL, so removing a row is
  -- idempotent (a second delete touches nothing) and leaves the audit trail.
  deleted_at timestamptz,
  deleted_by uuid REFERENCES app_users(id) ON DELETE SET NULL
);
CREATE TRIGGER product_adjustments_updated_at BEFORE UPDATE ON product_adjustments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX product_adjustments_product_idx ON product_adjustments (product_id, date DESC);
CREATE INDEX product_adjustments_live_idx ON product_adjustments (date DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX product_adjustments_location_idx ON product_adjustments (location_id)
  WHERE location_id IS NOT NULL;
CREATE INDEX product_adjustments_settlement_idx ON product_adjustments (settlement_id)
  WHERE settlement_id IS NOT NULL;
CREATE INDEX product_adjustments_created_by_idx ON product_adjustments (created_by);
CREATE UNIQUE INDEX product_adjustments_idempotency_idx
  ON product_adjustments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- Covers the per-SKU SUM(delta) aggregate every inventory read runs.
CREATE INDEX product_adjustments_live_product_idx
  ON product_adjustments (product_id)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE product_adjustments IS
  'Shrink and found stock for product_catalog SKUs. onHand(SKU) = batches out + SUM(delta) - sold.';
COMMENT ON COLUMN product_adjustments.delta IS
  'Signed units. Negative is shrink (a bottle broke, the shop counted short); positive is stock found.';

-- --------------------------------------------------------------------------
-- 2. Voidable product batches
-- --------------------------------------------------------------------------

ALTER TABLE product_batches
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN voided_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN void_reason text;

CREATE INDEX product_batches_live_idx ON product_batches (product_id)
  WHERE voided_at IS NULL;

COMMENT ON COLUMN product_batches.voided_at IS
  'Set by POST /product-batches/{id}/void. A voided batch produces nothing, consumes no propolis, and its honey bulk_use movement carries a reversing entry.';

-- +goose Down

-- Refuse to roll back over a voided batch: dropping voided_at would
-- resurrect its output while the negating honey_movements rows survive,
-- leaving a plausible-looking wrong ledger. Fail loudly instead.
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM product_batches WHERE voided_at IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back 00030: voided product batches exist; '
      'their honey reversal rows would desynchronise the ledger';
  END IF;
END $$;
-- +goose StatementEnd

DROP INDEX IF EXISTS product_batches_live_idx;
ALTER TABLE product_batches
  DROP COLUMN IF EXISTS void_reason,
  DROP COLUMN IF EXISTS voided_by,
  DROP COLUMN IF EXISTS voided_at;

DROP INDEX IF EXISTS product_adjustments_live_product_idx;
DROP TABLE IF EXISTS product_adjustments;
