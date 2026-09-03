-- +goose Up
-- Voidable bottling runs (roadmap "Void-bottling-run action", ASI-1-002).
--
-- A run-linked honey_movement refuses reversal on its own with a 409: the run,
-- its serials, and the lot's bottled total would survive the reversal and
-- disagree with the ledger forever. Voiding is the missing counterpart — it
-- reverses the movements, drops the run's unsold serials, and marks the run,
-- all in one transaction.
--
-- Soft, not a delete: honey_movements.bottling_run_id is ON DELETE RESTRICT
-- and the reversing entries keep pointing at the run, so the row has to stay.

ALTER TABLE bottling_runs
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN voided_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN void_reason text;

-- +goose Down
ALTER TABLE bottling_runs
  DROP COLUMN IF EXISTS voided_at,
  DROP COLUMN IF EXISTS voided_by,
  DROP COLUMN IF EXISTS void_reason;
