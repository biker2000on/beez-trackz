-- +goose Up
-- 1. Treatment withdrawal days: 00019 seeded every product at 0, which makes
--    the lockout a no-op once the treatment is marked removed. Seed label
--    values only where the operator has not edited the row (still 0 and
--    never updated). Operators can change these in Settings > Treatment
--    withdrawals; verify against the label in hand.
UPDATE treatment_products SET withdrawal_days = v.days,
  notes = COALESCE(notes, '') || CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE ' ' END || v.note
FROM (VALUES
  ('apivar',      14, 'Label: honey supers may go back on 14 days after strips are removed.'),
  ('checkmite+',  14, 'Label: honey supers may go back on 14 days after strips are removed.'),
  ('apilife var', 30, 'Label: do not use within 30 days of a honey flow; remove before supering.')
) AS v(name_key, days, note)
WHERE treatment_products.name_key = v.name_key
  AND treatment_products.withdrawal_days = 0
  AND treatment_products.updated_at = treatment_products.created_at;

-- 2. Propolis SKUs carry a net weight so a sold tin decrements grams on hand.
ALTER TABLE product_catalog
  ADD COLUMN net_grams double precision CHECK (net_grams IS NULL OR net_grams > 0);
COMMENT ON COLUMN product_catalog.net_grams IS
  'Net propolis grams per unit sold. Required for kind=propolis so sales decrement the harvest ledger; optional otherwise.';

-- 3. Colony/equipment physical effects (hive sold, feeders closed, equipment
--    disposed) apply when a sale reaches paid/fulfilled, not on draft/pending.
--    Marks when they were applied so cancel/restore and status changes are
--    idempotent. Existing sales already applied on create.
ALTER TABLE sales ADD COLUMN physical_applied_at timestamptz;
UPDATE sales SET physical_applied_at = COALESCE(created_at, now())
WHERE order_status <> 'cancelled'
  AND EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = sales.id AND si.kind IN ('colony', 'equipment'));

-- +goose Down
ALTER TABLE sales DROP COLUMN IF EXISTS physical_applied_at;
ALTER TABLE product_catalog DROP COLUMN IF EXISTS net_grams;
