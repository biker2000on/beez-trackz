-- +goose Up
-- Remaining Varroa program: board exposure days, comparable mites-per-day,
-- standalone-count uniqueness, treat-now / mite-check recommendation types,
-- and optional action-level settings.

ALTER TABLE mite_counts
    ADD COLUMN days_on_board integer
        CHECK (days_on_board IS NULL OR days_on_board > 0),
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE mite_counts
    ADD COLUMN mites_per_day double precision GENERATED ALWAYS AS (
        CASE
            WHEN method IN ('sticky_board', 'visual') AND days_on_board IS NOT NULL
                THEN mites_count::double precision / days_on_board
            ELSE NULL
        END
    ) STORED;

CREATE TRIGGER mite_counts_updated_at BEFORE UPDATE ON mite_counts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- UNIQUE (inspection_id, method) never fired for standalone counts: NULL
-- does not conflict with NULL. Split into two partial uniques so inspection
-- rows still upsert by method and standalone rows upsert by hive/date/method.
ALTER TABLE mite_counts DROP CONSTRAINT mite_counts_inspection_id_method_key;

CREATE UNIQUE INDEX mite_counts_inspection_method_uidx
    ON mite_counts (inspection_id, method)
    WHERE inspection_id IS NOT NULL;

CREATE UNIQUE INDEX mite_counts_standalone_uidx
    ON mite_counts (hive_id, date, method)
    WHERE inspection_id IS NULL;

ALTER TYPE recommendation_type ADD VALUE 'treat_now';
ALTER TYPE recommendation_type ADD VALUE 'mite_check_due';

ALTER TABLE user_settings
    ADD COLUMN mite_threshold_per_100 double precision
        CHECK (mite_threshold_per_100 IS NULL OR mite_threshold_per_100 > 0),
    ADD COLUMN mite_threshold_per_day double precision
        CHECK (mite_threshold_per_day IS NULL OR mite_threshold_per_day > 0),
    ADD COLUMN mite_check_interval_days integer
        CHECK (mite_check_interval_days IS NULL OR mite_check_interval_days > 0);

-- +goose Down
ALTER TABLE user_settings
    DROP COLUMN IF EXISTS mite_threshold_per_100,
    DROP COLUMN IF EXISTS mite_threshold_per_day,
    DROP COLUMN IF EXISTS mite_check_interval_days;

DROP INDEX IF EXISTS mite_counts_standalone_uidx;
DROP INDEX IF EXISTS mite_counts_inspection_method_uidx;
ALTER TABLE mite_counts
    ADD CONSTRAINT mite_counts_inspection_id_method_key UNIQUE (inspection_id, method);

DROP TRIGGER IF EXISTS mite_counts_updated_at ON mite_counts;
ALTER TABLE mite_counts
    DROP COLUMN IF EXISTS mites_per_day,
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS days_on_board;

-- Enum values cannot be removed safely; leave treat_now / mite_check_due.
