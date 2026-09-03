-- +goose Up
-- Durable restore state for the GnuCash integration.
--
-- Until now "a snapshot restore installed this book identity and cursor, and
-- the reconciliation has not been signed off" was derived: book_guid present,
-- changes_cursor present, sync_enabled false. That heuristic has two faults
-- the P0 round-trip gate cannot live with:
--
--   * it is a false positive for an operator who merely paused a healthy
--     integration, who then has to say discardRestore before rotating a token;
--   * it cannot be *cleared* by anything except changing one of the three
--     inputs, so the reconciliation sign-off had nowhere to be recorded and
--     "sync is off" had to stand in for "reconciliation is pending".
--
-- The column makes the window explicit and, crucially, one-way:
--
--   none       ordinary operation. Nothing was restored, or the restore has
--              been finished or deliberately discarded.
--   installed  POST /settings/gnucash/restore proved the credentials open the
--              artifact's book and installed the preserved cursor, book
--              identity, and per-row sync state. Sync MUST stay disabled.
--   reconciled an admin acknowledged the pull-first reconciliation and the
--              no-write push dry run. This is the ONLY state from which
--              sync_enabled may be turned back on after a restore.
--
-- Existing rows get 'none': no restore has run through the guarded command on
-- any live database, and a working integration must not come back as pending.
ALTER TABLE gnucash_sync_settings
  ADD COLUMN restore_state text NOT NULL DEFAULT 'none'
    CHECK (restore_state IN ('none', 'installed', 'reconciled'));

COMMENT ON COLUMN gnucash_sync_settings.restore_state IS
  'none | installed | reconciled. installed means a guarded snapshot restore is pending reconciliation and sync must stay disabled; only reconciled permits re-enabling sync afterwards.';

-- +goose Down
ALTER TABLE gnucash_sync_settings DROP COLUMN IF EXISTS restore_state;
