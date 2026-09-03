-- +goose Up
-- Action-center style triage for recommendations: snooze keeps a row
-- undismissed (so the engine's dedup still suppresses duplicates) but hides
-- it from the pending view until snoozed_until passes; dismissals record
-- who and when so the dismissed view is an audit trail, not a void.
ALTER TABLE ai_recommendations
    ADD COLUMN snoozed_until timestamptz,
    ADD COLUMN dismissed_at timestamptz,
    ADD COLUMN dismissed_by uuid REFERENCES app_users(id) ON DELETE SET NULL;

CREATE INDEX ai_recommendations_pending_idx
    ON ai_recommendations (dismissed, snoozed_until);

-- +goose Down
DROP INDEX IF EXISTS ai_recommendations_pending_idx;
ALTER TABLE ai_recommendations
    DROP COLUMN IF EXISTS snoozed_until,
    DROP COLUMN IF EXISTS dismissed_at,
    DROP COLUMN IF EXISTS dismissed_by;
