-- +goose Up
-- ASI review hardening (2026-08-11): ASI-5-007, ASI-1-009, ASI-5-008.

-- ASI-5-007: the recommendations dedup was a non-transactional
-- SELECT-then-INSERT, so concurrent runs (scaled workers, overlapping manual
-- runs) could both pass the check. Enforce it in the database. Existing
-- duplicates are dismissed keeping the newest, then the partial unique index
-- makes the invariant permanent.
UPDATE ai_recommendations SET dismissed = true, dismissed_at = now()
WHERE id IN (
    SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
            PARTITION BY type,
                COALESCE(hive_id, '00000000-0000-0000-0000-000000000000'::uuid)
            ORDER BY created_at DESC) AS rn
        FROM ai_recommendations
        WHERE dismissed = false) ranked
    WHERE rn > 1);

CREATE UNIQUE INDEX ai_recommendations_active_unique
    ON ai_recommendations (type,
        COALESCE(hive_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE dismissed = false;

-- ASI-1-009: ON DELETE SET NULL on jar_serials.sale_id contradicted the
-- CHECK ((sale_id IS NULL) = (sold_at IS NULL)) — a sale-row delete would
-- null only sale_id and violate the CHECK. No endpoint deletes sales;
-- RESTRICT makes the invariant explicit instead of accidentally enforced.
ALTER TABLE jar_serials DROP CONSTRAINT jar_serials_sale_id_fkey;
ALTER TABLE jar_serials
    ADD CONSTRAINT jar_serials_sale_id_fkey
    FOREIGN KEY (sale_id) REFERENCES honey_sales(id) ON DELETE RESTRICT;

-- ASI-5-008: a replayed mutation id must return the receipt for the SAME
-- request. Without a fingerprint, a client bug or UUID collision silently
-- returns request A's stored response to request B and B's write never runs.
ALTER TABLE offline_mutation_receipts ADD COLUMN request_hash text;

-- +goose Down
ALTER TABLE offline_mutation_receipts DROP COLUMN IF EXISTS request_hash;
ALTER TABLE jar_serials DROP CONSTRAINT jar_serials_sale_id_fkey;
ALTER TABLE jar_serials
    ADD CONSTRAINT jar_serials_sale_id_fkey
    FOREIGN KEY (sale_id) REFERENCES honey_sales(id) ON DELETE SET NULL;
DROP INDEX IF EXISTS ai_recommendations_active_unique;
