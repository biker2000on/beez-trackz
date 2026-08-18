-- +goose Up
-- Source-retained media (cairn model): versioned transcripts, lineage from
-- parser-created domain rows back to the recording, and pluggable photo
-- originals (MinIO always; Immich optional). A complete transcript is never
-- overwritten; delete of a source refuses while derived rows still point at it.

CREATE TABLE transcript_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_file_id uuid NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text,
  prompt_revision text,
  produced_at timestamptz NOT NULL DEFAULT now(),
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transcript_versions_media_file_idx
  ON transcript_versions (media_file_id, produced_at DESC);

-- Pointer only; no FK. media_files <-> transcript_versions would otherwise
-- deadlock a delete (versions CASCADE from the file, file points at a version).
ALTER TABLE media_files
  ADD COLUMN current_transcript_version_id uuid;

CREATE INDEX media_files_current_version_idx
  ON media_files (current_transcript_version_id)
  WHERE current_transcript_version_id IS NOT NULL;

INSERT INTO transcript_versions (media_file_id, provider, model, prompt_revision, produced_at, text)
SELECT id, 'unknown', NULL, 'legacy', COALESCE(updated_at, created_at), transcription_text
FROM media_files
WHERE transcription_status = 'complete' AND COALESCE(transcription_text, '') <> '';

UPDATE media_files mf
SET current_transcript_version_id = tv.id
FROM transcript_versions tv
WHERE tv.media_file_id = mf.id
  AND mf.transcription_status = 'complete'
  AND COALESCE(mf.transcription_text, '') <> '';

ALTER TABLE inspections
  ADD COLUMN source_media_file_id uuid REFERENCES media_files(id),
  ADD COLUMN source_transcript_version_id uuid REFERENCES transcript_versions(id);
CREATE INDEX inspections_source_media_idx
  ON inspections (source_media_file_id)
  WHERE source_media_file_id IS NOT NULL;

UPDATE inspections i
SET source_media_file_id = (i.source_media->>'mediaFileId')::uuid
WHERE i.source_media ? 'mediaFileId'
  AND (i.source_media->>'mediaFileId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND EXISTS (
    SELECT 1 FROM media_files mf
    WHERE mf.id = (i.source_media->>'mediaFileId')::uuid
  );

UPDATE inspections i
SET source_transcript_version_id = mf.current_transcript_version_id
FROM media_files mf
WHERE i.source_media_file_id = mf.id
  AND mf.current_transcript_version_id IS NOT NULL;

ALTER TABLE feedings
  ADD COLUMN source_media_file_id uuid REFERENCES media_files(id),
  ADD COLUMN source_transcript_version_id uuid REFERENCES transcript_versions(id);
CREATE INDEX feedings_source_media_idx
  ON feedings (source_media_file_id)
  WHERE source_media_file_id IS NOT NULL;

ALTER TABLE treatment_events
  ADD COLUMN source_media_file_id uuid REFERENCES media_files(id),
  ADD COLUMN source_transcript_version_id uuid REFERENCES transcript_versions(id);
CREATE INDEX treatment_events_source_media_idx
  ON treatment_events (source_media_file_id)
  WHERE source_media_file_id IS NOT NULL;

ALTER TABLE mite_counts
  ADD COLUMN source_media_file_id uuid REFERENCES media_files(id),
  ADD COLUMN source_transcript_version_id uuid REFERENCES transcript_versions(id);
CREATE INDEX mite_counts_source_media_idx
  ON mite_counts (source_media_file_id)
  WHERE source_media_file_id IS NOT NULL;

CREATE TYPE photo_storage_backend AS ENUM ('minio', 'immich');

ALTER TABLE photos
  ADD COLUMN storage_backend photo_storage_backend NOT NULL DEFAULT 'minio',
  ADD COLUMN original_ref text,
  ADD COLUMN original_external boolean NOT NULL DEFAULT false;

UPDATE photos SET original_ref = original_key WHERE original_ref IS NULL;

ALTER TABLE photos ALTER COLUMN original_key DROP NOT NULL;
ALTER TABLE photos ALTER COLUMN original_ref SET NOT NULL;

ALTER TABLE photos ADD CONSTRAINT photos_original_backend_ck CHECK (
  (storage_backend = 'minio'
    AND original_key IS NOT NULL
    AND original_ref = original_key
    AND original_external = false)
  OR
  (storage_backend = 'immich'
    AND original_ref <> ''
    AND original_key IS NULL)
);

-- Lot photos used to CASCADE on photo delete, which would take a honey-story
-- image out from under a live lot. Refuse instead; the API maps this to 409.
ALTER TABLE harvest_lot_photos DROP CONSTRAINT harvest_lot_photos_photo_id_fkey;
ALTER TABLE harvest_lot_photos
  ADD CONSTRAINT harvest_lot_photos_photo_id_fkey
  FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE RESTRICT;

-- +goose Down
ALTER TABLE harvest_lot_photos DROP CONSTRAINT harvest_lot_photos_photo_id_fkey;
ALTER TABLE harvest_lot_photos
  ADD CONSTRAINT harvest_lot_photos_photo_id_fkey
  FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE;

ALTER TABLE photos DROP CONSTRAINT IF EXISTS photos_original_backend_ck;
ALTER TABLE photos DROP COLUMN IF EXISTS original_external;
ALTER TABLE photos DROP COLUMN IF EXISTS original_ref;
ALTER TABLE photos DROP COLUMN IF EXISTS storage_backend;
ALTER TABLE photos ALTER COLUMN original_key SET NOT NULL;
DROP TYPE IF EXISTS photo_storage_backend;

ALTER TABLE mite_counts DROP COLUMN IF EXISTS source_transcript_version_id;
ALTER TABLE mite_counts DROP COLUMN IF EXISTS source_media_file_id;
ALTER TABLE treatment_events DROP COLUMN IF EXISTS source_transcript_version_id;
ALTER TABLE treatment_events DROP COLUMN IF EXISTS source_media_file_id;
ALTER TABLE feedings DROP COLUMN IF EXISTS source_transcript_version_id;
ALTER TABLE feedings DROP COLUMN IF EXISTS source_media_file_id;
ALTER TABLE inspections DROP COLUMN IF EXISTS source_transcript_version_id;
ALTER TABLE inspections DROP COLUMN IF EXISTS source_media_file_id;

ALTER TABLE media_files DROP COLUMN IF EXISTS current_transcript_version_id;
DROP TABLE IF EXISTS transcript_versions;
