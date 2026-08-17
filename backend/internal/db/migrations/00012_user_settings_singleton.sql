-- +goose Up
-- API-001: user_settings is instance-wide and must contain at most one row.
-- Concurrent /auth/setup could previously insert two rows; login then used an
-- unordered LIMIT 1 and would accept either password.
--
-- If duplicates already exist, keep the oldest row. Production should already
-- have exactly one.
DELETE FROM user_settings
WHERE id NOT IN (
    SELECT id FROM (
        SELECT id FROM user_settings
        ORDER BY created_at ASC, id ASC
        LIMIT 1
    ) keep
);

CREATE UNIQUE INDEX user_settings_singleton ON user_settings ((true));

-- +goose Down
DROP INDEX IF EXISTS user_settings_singleton;
