-- +goose Up
-- Optional idempotency keys on equipment ledgers, matching
-- stock_movements (00024) and product_adjustments (00030): a partial
-- unique index so NULL keys stay unconstrained and a replay of the same
-- key cannot double-apply.
--
-- equipment_deployments is included so POST /equipment/deployments can
-- return the previously-created row instead of deploying twice; the
-- three ledgers named in the original list cannot record a deploy.

ALTER TABLE equipment_stock_adjustments
  ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX equipment_stock_adjustments_idempotency_idx
  ON equipment_stock_adjustments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE equipment_state_changes
  ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX equipment_state_changes_idempotency_idx
  ON equipment_state_changes (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE equipment_deployment_returns
  ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX equipment_deployment_returns_idempotency_idx
  ON equipment_deployment_returns (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE equipment_deployments
  ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX equipment_deployments_idempotency_idx
  ON equipment_deployments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS equipment_deployments_idempotency_idx;
ALTER TABLE equipment_deployments DROP COLUMN IF EXISTS idempotency_key;

DROP INDEX IF EXISTS equipment_deployment_returns_idempotency_idx;
ALTER TABLE equipment_deployment_returns DROP COLUMN IF EXISTS idempotency_key;

DROP INDEX IF EXISTS equipment_state_changes_idempotency_idx;
ALTER TABLE equipment_state_changes DROP COLUMN IF EXISTS idempotency_key;

DROP INDEX IF EXISTS equipment_stock_adjustments_idempotency_idx;
ALTER TABLE equipment_stock_adjustments DROP COLUMN IF EXISTS idempotency_key;
