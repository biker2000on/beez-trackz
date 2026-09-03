-- +goose Up
-- Feeding lifecycle: explicit feeder state, refill chains, and an audit-safe,
-- REVERSIBLE correction of the legacy "no end date" records.
--
-- Why this exists
-- ---------------
-- The 2026-08-02 production audit found 81 feeding rows across 22 hives with
-- date_empty IS NULL, every one fed more than 90 days earlier. An empty
-- date_empty therefore does NOT prove a feeder is still on the hive; it only
-- proves nobody recorded the end of that feeding. Treating those rows as
-- active feeders produced duplicate, permanently "urgent" dashboard rows.
--
-- What this migration changes
-- ---------------------------
--   * feedings.status makes the active-feeder rule explicit:
--       'open'       — a feeder is on the hive right now.
--       'closed'     — the feeder episode ended; closed_at records when.
--       'unverified' — no end was ever recorded and the record is too old to
--                      trust either way. NOT counted as an active feeder;
--                      surfaced to the beekeeper as "verify and close".
--   * feedings.refill_of_id links a refill to the feeding it replaces. A
--     refill closes its predecessor in the same transaction and the unique
--     index below allows at most one successor per feeding, so a feeder chain
--     can never contain two open rows — duplicate status rows cannot return.
--
-- Audit safety / reversibility
-- ----------------------------
--   * No feeding row is deleted and no original value is rewritten. In
--     particular this migration NEVER writes feedings.date_empty, so the
--     original (empty) history is preserved exactly.
--   * Every row it touches is recorded in feeding_status_backfills with its
--     prior status, prior date_empty, the batch, and the reason.
--   * Reverse the data correction, leaving the schema in place, with:
--
--       UPDATE feedings f
--       SET status = b.prior_status,
--           closed_at = b.prior_closed_at,
--           closed_reason = b.prior_closed_reason
--       FROM feeding_status_backfills b
--       WHERE b.feeding_id = f.id
--         AND b.batch = '00007_stale_open_feeders'
--         AND b.reverted_at IS NULL;
--
--       UPDATE feeding_status_backfills SET reverted_at = now()
--       WHERE batch = '00007_stale_open_feeders' AND reverted_at IS NULL;
--
--     (Use batch '00007_derive_closed' for the rows whose status was derived
--     from an end date that was already recorded.)
--   * `goose down` removes the added columns entirely, which restores the
--     pre-migration table exactly (refill links are the only new information
--     and they are, by definition, post-migration data).

CREATE TYPE feeding_state AS ENUM ('open', 'closed', 'unverified');

ALTER TABLE feedings
  ADD COLUMN status feeding_state NOT NULL DEFAULT 'open',
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN closed_reason text,
  ADD COLUMN refill_of_id uuid REFERENCES feedings(id),
  ADD COLUMN status_changed_at timestamptz,
  ADD COLUMN status_changed_by uuid REFERENCES app_users(id);

-- A closed feeding always records when it closed; an open or unverified one
-- never does. This is the constraint that keeps the state machine honest.
ALTER TABLE feedings ADD CONSTRAINT feedings_closed_state_ck
  CHECK ((status = 'closed') = (closed_at IS NOT NULL));

-- At most one refill per feeding: feeder episodes form a strict chain.
CREATE UNIQUE INDEX feedings_refill_of_idx ON feedings (refill_of_id)
  WHERE refill_of_id IS NOT NULL;

CREATE INDEX feedings_hive_status_idx ON feedings (hive_id, status);

-- Audit log for every status write this migration performs.
CREATE TABLE feeding_status_backfills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feeding_id uuid NOT NULL REFERENCES feedings(id) ON DELETE CASCADE,
  batch text NOT NULL,
  reason text NOT NULL,
  prior_status feeding_state NOT NULL,
  prior_date_empty timestamptz,
  prior_closed_at timestamptz,
  prior_closed_reason text,
  new_status feeding_state NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL DEFAULT 'migration 00007_feeding_lifecycle',
  reverted_at timestamptz
);
CREATE INDEX feeding_status_backfills_feeding_idx
  ON feeding_status_backfills (feeding_id);
CREATE INDEX feeding_status_backfills_batch_idx
  ON feeding_status_backfills (batch) WHERE reverted_at IS NULL;

-- Step 1 — rows that already carry an end date are closed. This is a
-- derivation from a fact the operator recorded, not a correction.
INSERT INTO feeding_status_backfills
  (feeding_id, batch, reason, prior_status, prior_date_empty, new_status)
SELECT id, '00007_derive_closed',
       'date_empty was already recorded; status derived from it',
       status, date_empty, 'closed'
FROM feedings
WHERE date_empty IS NOT NULL;

UPDATE feedings
SET status = 'closed', closed_at = date_empty, closed_reason = 'emptied'
WHERE date_empty IS NOT NULL;

-- Step 2 — the audited problem: no end date, and last fed more than 90 days
-- ago. These become 'unverified' (not 'closed'): the app must not claim the
-- feeder was removed, only that its presence is unproven. date_empty is left
-- untouched so nothing about the original record is lost.
INSERT INTO feeding_status_backfills
  (feeding_id, batch, reason, prior_status, prior_date_empty, new_status)
SELECT id, '00007_stale_open_feeders',
       'no end date recorded and last fed more than 90 days ago; feeder presence unverified',
       status, date_empty, 'unverified'
FROM feedings
WHERE date_empty IS NULL
  AND date_fed < now() - interval '90 days';

UPDATE feedings
SET status = 'unverified'
WHERE date_empty IS NULL
  AND date_fed < now() - interval '90 days';

-- +goose Down
DROP INDEX IF EXISTS feedings_hive_status_idx;
DROP INDEX IF EXISTS feedings_refill_of_idx;
ALTER TABLE feedings DROP CONSTRAINT IF EXISTS feedings_closed_state_ck;
DROP TABLE IF EXISTS feeding_status_backfills;
ALTER TABLE feedings
  DROP COLUMN IF EXISTS status_changed_by,
  DROP COLUMN IF EXISTS status_changed_at,
  DROP COLUMN IF EXISTS refill_of_id,
  DROP COLUMN IF EXISTS closed_reason,
  DROP COLUMN IF EXISTS closed_at,
  DROP COLUMN IF EXISTS status;
DROP TYPE IF EXISTS feeding_state;
