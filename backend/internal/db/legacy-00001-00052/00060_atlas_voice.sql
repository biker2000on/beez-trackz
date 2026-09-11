-- +goose Up
ALTER TABLE media_files ADD COLUMN capture_id uuid, ADD COLUMN capture_actor_id uuid REFERENCES app_users(id),
 ADD COLUMN audio_sha256 text, ADD COLUMN capture_mode text NOT NULL DEFAULT 'single' CHECK (capture_mode IN ('single','batch','apiary')),
 ADD COLUMN observed_at timestamptz, ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC',
 ADD COLUMN replaces_media_file_id uuid REFERENCES media_files(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX media_capture_actor_unique ON media_files(capture_actor_id,capture_id) WHERE capture_id IS NOT NULL;
ALTER TABLE transcript_versions ADD COLUMN parsed_inspections jsonb;
UPDATE media_files SET capture_mode='batch' WHERE owner_type='apiary';
CREATE TABLE apiary_inspections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), apiary_id uuid NOT NULL REFERENCES apiaries(id),
 observed_at timestamptz NOT NULL, notes text NOT NULL CHECK (length(trim(notes)) > 0),
 created_by uuid REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
 capture_id uuid, source_media_file_id uuid REFERENCES media_files(id) ON DELETE SET NULL,
 source_transcript_version_id uuid REFERENCES transcript_versions(id) ON DELETE SET NULL
);
CREATE INDEX apiary_inspections_history ON apiary_inspections(apiary_id,observed_at DESC);
CREATE UNIQUE INDEX apiary_manual_capture ON apiary_inspections(created_by,capture_id) WHERE capture_id IS NOT NULL;
-- Receipts contain command identity and record IDs, never audio/transcript copies.
CREATE TABLE transcription_confirmations (
 media_file_id uuid NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
 item_key text NOT NULL, source_transcript_version_id uuid REFERENCES transcript_versions(id) ON DELETE SET NULL,
 actor_id uuid REFERENCES app_users(id), mutation_id uuid,
 payload_hash text NOT NULL, outcome jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(media_file_id,item_key)
);
CREATE UNIQUE INDEX transcription_confirmation_mutation ON transcription_confirmations(actor_id,mutation_id) WHERE mutation_id IS NOT NULL;
-- +goose Down
ALTER TABLE transcript_versions DROP COLUMN parsed_inspections;
DROP TABLE transcription_confirmations;
DROP TABLE apiary_inspections;
DROP INDEX media_capture_actor_unique;
ALTER TABLE media_files DROP COLUMN capture_id, DROP COLUMN capture_actor_id, DROP COLUMN audio_sha256,
 DROP COLUMN capture_mode, DROP COLUMN observed_at, DROP COLUMN time_zone, DROP COLUMN replaces_media_file_id;
