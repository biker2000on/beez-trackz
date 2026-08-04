-- +goose Up
-- Serialized jar traceability (roadmap "Harvest lots, jar runs, and
-- customer-facing QR honey stories").
--
-- Serials were write-only: generated during a bottling run, counted on the lot
-- view, and linked to nothing downstream. A serial's chain stopped at its run,
-- so "which jar went to which customer" had no answer at the data level.
--
-- This migration closes the downstream half of the chain:
--
--   jar_serial -> bottling_run -> harvest_lot        (already existed)
--   jar_serial -> honey_sale                         (added here)
--
-- Purely additive: three nullable columns and two indexes. No backfill is
-- possible or attempted — existing serials are simply "not sold yet", which is
-- exactly what a NULL sale_id means.

ALTER TABLE jar_serials
    -- ON DELETE SET NULL, not CASCADE: deleting a sale must never destroy the
    -- jar's provenance record. The serial survives as unsold.
    ADD COLUMN sale_id uuid REFERENCES honey_sales(id) ON DELETE SET NULL,
    ADD COLUMN sold_at timestamptz,
    ADD COLUMN linked_by uuid REFERENCES app_users(id) ON DELETE SET NULL;

-- The three columns move together: linked means all of sale_id/sold_at are
-- set, unlinked means both are NULL. linked_by stays optional (a system or
-- token-authenticated link has no app_user).
ALTER TABLE jar_serials
    ADD CONSTRAINT jar_serials_sale_link_ck
    CHECK ((sale_id IS NULL) = (sold_at IS NULL));

-- Partial: the vast majority of serials are unsold, and every query that uses
-- this index ("what did this sale ship?") filters on a non-null sale_id.
CREATE INDEX jar_serials_sale_idx ON jar_serials (sale_id) WHERE sale_id IS NOT NULL;

-- Serial lookup is case-insensitive (people retype the code off a jar lid),
-- so the lookup predicate is lower(serial_number) and needs its own index —
-- the UNIQUE constraint on serial_number cannot serve it.
CREATE INDEX jar_serials_serial_lower_idx ON jar_serials (lower(serial_number));

-- +goose Down
DROP INDEX IF EXISTS jar_serials_serial_lower_idx;
DROP INDEX IF EXISTS jar_serials_sale_idx;
ALTER TABLE jar_serials DROP CONSTRAINT IF EXISTS jar_serials_sale_link_ck;
ALTER TABLE jar_serials
    DROP COLUMN IF EXISTS sale_id,
    DROP COLUMN IF EXISTS sold_at,
    DROP COLUMN IF EXISTS linked_by;
