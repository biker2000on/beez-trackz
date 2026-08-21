-- +goose Up
-- Soft-delete / audit on mite_counts, matching propolis_harvests.
-- Partial uniques ignore deleted rows so a replacement count can be inserted.

ALTER TABLE mite_counts
    ADD COLUMN created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
    ADD COLUMN deleted_at timestamptz,
    ADD COLUMN deleted_by uuid REFERENCES app_users(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS mite_counts_inspection_method_uidx;
DROP INDEX IF EXISTS mite_counts_standalone_uidx;

CREATE UNIQUE INDEX mite_counts_inspection_method_uidx
    ON mite_counts (inspection_id, method)
    WHERE inspection_id IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX mite_counts_standalone_uidx
    ON mite_counts (hive_id, date, method)
    WHERE inspection_id IS NULL AND deleted_at IS NULL;

CREATE INDEX mite_counts_live_idx
    ON mite_counts (hive_id, date DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX mite_counts_created_by_idx ON mite_counts (created_by);

-- +goose Down
DROP INDEX IF EXISTS mite_counts_created_by_idx;
DROP INDEX IF EXISTS mite_counts_live_idx;
DROP INDEX IF EXISTS mite_counts_standalone_uidx;
DROP INDEX IF EXISTS mite_counts_inspection_method_uidx;

CREATE UNIQUE INDEX mite_counts_inspection_method_uidx
    ON mite_counts (inspection_id, method)
    WHERE inspection_id IS NOT NULL;

CREATE UNIQUE INDEX mite_counts_standalone_uidx
    ON mite_counts (hive_id, date, method)
    WHERE inspection_id IS NULL;

ALTER TABLE mite_counts
    DROP COLUMN IF EXISTS deleted_by,
    DROP COLUMN IF EXISTS deleted_at,
    DROP COLUMN IF EXISTS created_by;
