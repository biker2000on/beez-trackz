-- +goose Up
-- Restart-safe Immich yard scans retain the bounded search result separately
-- from adopted photos. Review candidates can therefore survive an Immich
-- outage, a worker restart, and later changes to the pin or search model.

CREATE TABLE immich_timeline_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apiary_id uuid NOT NULL REFERENCES apiaries(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  task_id text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  matched_count integer NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
  adopted_count integer NOT NULL DEFAULT 0 CHECK (adopted_count >= 0),
  review_count integer NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  error text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE UNIQUE INDEX immich_timeline_scans_one_active_idx
  ON immich_timeline_scans (apiary_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX immich_timeline_scans_history_idx
  ON immich_timeline_scans (apiary_id, requested_at DESC);

CREATE TABLE immich_timeline_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apiary_id uuid NOT NULL REFERENCES apiaries(id) ON DELETE CASCADE,
  immich_asset_id text NOT NULL,
  original_filename text,
  taken_date timestamptz,
  latitude double precision CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  matched_terms text[] NOT NULL DEFAULT '{}',
  nearby_apiary_ids uuid[] NOT NULL DEFAULT '{}',
  review_state text NOT NULL DEFAULT 'pending'
    CHECK (review_state IN ('pending', 'adopted', 'rejected')),
  review_reason text NOT NULL,
  auto_adopted boolean NOT NULL DEFAULT false,
  photo_id uuid UNIQUE REFERENCES photos(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_scan_id uuid REFERENCES immich_timeline_scans(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  UNIQUE (apiary_id, immich_asset_id),
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);

CREATE INDEX immich_timeline_candidates_review_idx
  ON immich_timeline_candidates (apiary_id, review_state, taken_date);
CREATE INDEX immich_timeline_candidates_photo_idx
  ON immich_timeline_candidates (photo_id)
  WHERE photo_id IS NOT NULL;

-- A comparison strip is useful only when the operator identifies the stable
-- angle/subject (for example "front entrance" or "brood frame 3"). Keeping
-- this nullable prevents the gallery from pretending unrelated shots match.
ALTER TABLE photos ADD COLUMN comparison_angle text;
ALTER TABLE photos ADD CONSTRAINT photos_comparison_angle_ck
  CHECK (comparison_angle IS NULL OR char_length(btrim(comparison_angle)) BETWEEN 1 AND 80);
CREATE INDEX photos_hive_comparison_idx
  ON photos (owner_id, comparison_angle, taken_date)
  WHERE owner_type = 'hive' AND comparison_angle IS NOT NULL AND taken_date IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS photos_hive_comparison_idx;
ALTER TABLE photos DROP CONSTRAINT IF EXISTS photos_comparison_angle_ck;
ALTER TABLE photos DROP COLUMN IF EXISTS comparison_angle;
DROP TABLE IF EXISTS immich_timeline_candidates;
DROP TABLE IF EXISTS immich_timeline_scans;
