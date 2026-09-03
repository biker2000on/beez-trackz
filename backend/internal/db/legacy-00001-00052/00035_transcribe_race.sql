-- +goose Up
-- A forced re-transcription supersedes any still-scheduled retry of the
-- original task. Persist that operator intent so workers can resolve the race
-- consistently even when the API and worker run in different processes.
ALTER TABLE media_files
  ADD COLUMN retranscription_requested_at timestamptz;

-- +goose Down
ALTER TABLE media_files
  DROP COLUMN IF EXISTS retranscription_requested_at;
