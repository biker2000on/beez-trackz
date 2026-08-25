-- +goose Up
-- Push/pull bookkeeping the sync engine needs on top of the 00005 mapping
-- table.
--
-- content_hash is the hash of the transaction body we last sent. A rescan
-- that computes a different hash means the local entity changed since the
-- last push, which is what separates 'remote_newer' from 'diverged' when the
-- pull sees a remote edit on the same row.
--
-- remote_enter_date is folio's enterDate for the linked transaction. GET
-- changes reports it on every edit, so "did someone edit this in GnuCash"
-- is a comparison against the value we stored at push time, not a guess.

ALTER TABLE external_sync
  ADD COLUMN content_hash text,
  ADD COLUMN remote_transaction_guid text,
  ADD COLUMN remote_enter_date timestamptz;

-- The push scan walks (system, sync_state); the pull resolves an incoming
-- item by its externalId. 00005 already has a unique index on
-- (system, entity_type, external_id) WHERE external_id IS NOT NULL, but the
-- pull knows only the externalId, not which entity type produced it.
CREATE INDEX external_sync_external_lookup_idx
  ON external_sync (system, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX external_sync_conflict_idx
  ON external_sync (system, conflict_state)
  WHERE conflict_state IS NOT NULL AND conflict_state <> 'none';

COMMENT ON COLUMN external_sync.content_hash IS
  'Hash of the last pushed transaction body; a mismatch on rescan means local edits.';
COMMENT ON COLUMN external_sync.remote_enter_date IS
  'enterDate reported by the external system for the linked transaction.';

-- +goose Down
DROP INDEX IF EXISTS external_sync_conflict_idx;
DROP INDEX IF EXISTS external_sync_external_lookup_idx;
ALTER TABLE external_sync
  DROP COLUMN IF EXISTS remote_enter_date,
  DROP COLUMN IF EXISTS remote_transaction_guid,
  DROP COLUMN IF EXISTS content_hash;
