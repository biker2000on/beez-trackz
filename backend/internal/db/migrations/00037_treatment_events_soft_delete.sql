-- +goose Up
-- A treatment event is the row that decides whether honey is legal to sell.
-- Editing an inspection's treatments used to hard-delete dropped events, so
-- the proof a treatment was applied could vanish without a trace. Soft
-- delete with attribution, following mite_counts (00036).
ALTER TABLE treatment_events
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES app_users(id) ON DELETE SET NULL;

CREATE INDEX treatment_events_live_hive_idx
  ON treatment_events (hive_id, date_applied DESC)
  WHERE deleted_at IS NULL;

-- +goose Down
-- Purge tombstones before dropping the columns; the pre-00037 code would
-- otherwise resurrect them as live treatments and re-lock hives.
DELETE FROM treatment_events WHERE deleted_at IS NOT NULL;
DROP INDEX IF EXISTS treatment_events_live_hive_idx;
ALTER TABLE treatment_events
  DROP COLUMN IF EXISTS deleted_by,
  DROP COLUMN IF EXISTS deleted_at;
