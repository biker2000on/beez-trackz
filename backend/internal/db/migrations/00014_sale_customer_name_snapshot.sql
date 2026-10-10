-- +goose Up
-- A sale recorded for a saved customer now stores the customer's sale name in
-- sales.customer_name — the company when the customer has one, else the
-- customer's name (sales.SaleCustomerName) — so the Folio push describes it by
-- customer instead of falling back to the location. Backfill the existing
-- sales that name a saved customer but stored no name, with the same rule.
--
-- Data only: no column changes. Cancelled sales are left alone (struck from
-- the record). Already-pushed sales are not marked pending here: the Folio push
-- rebuilds every non-ignored row of the active book and compares its content
-- hash, so the next sync updates a changed description by itself.
-- Both chains run this same file.
UPDATE sales s
SET customer_name = COALESCE(NULLIF(btrim(c.company_name), ''), NULLIF(btrim(c.name), ''))
FROM customers c
WHERE c.id = s.customer_id
  AND s.order_status <> 'cancelled'
  AND NULLIF(btrim(s.customer_name), '') IS NULL
  AND COALESCE(NULLIF(btrim(c.company_name), ''), NULLIF(btrim(c.name), '')) IS NOT NULL;

-- +goose Down
-- Irreversible by design: a backfilled name cannot be told apart from one
-- recorded after this migration, and leaving it is harmless.
