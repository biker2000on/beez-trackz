-- +goose Up
-- Refinements to the Folio history import (00011), which is already applied
-- in production, so they are a migration of their own.
--
-- Refunds are negative. A refund credited to an imported expense account is a
-- NEGATIVE expense (it reduces expense totals; it is not income), so
-- expenses.amount_cents loses its non-negative CHECK. Only the import writes
-- one; manual entry (POST /expenses, colony intake cost) still refuses a
-- negative amount in the API. other_income.amount_cents is signed too: a
-- negative entry is money paid back out of an income account. The 'refund'
-- other-income category goes away (refunds are negative expenses now).
-- folio_imports.remote_amount_cents is signed for the same reason.
--
-- Deletions. folio_imports.remote_deleted_at records when Folio last reported
-- the transaction deleted (its deletion-stream deletedAt, or the time a full
-- scan missed it), so a re-delivered report is not raised again after the
-- operator kept the entry; cleared when the transaction is seen alive.
-- Both chains run this same file.
ALTER TABLE expenses DROP CONSTRAINT expenses_amount_cents_check;

UPDATE other_income SET category = 'other' WHERE category = 'refund';
ALTER TABLE other_income DROP CONSTRAINT other_income_category_check;
ALTER TABLE other_income ADD CONSTRAINT other_income_category_check CHECK (category IN (
  'uncategorized', 'sales_deposit', 'honey_sales', 'colony_sales',
  'product_sales', 'pollination', 'services', 'grant', 'other'));
ALTER TABLE other_income DROP CONSTRAINT other_income_amount_cents_check;

ALTER TABLE folio_imports DROP CONSTRAINT folio_imports_remote_amount_cents_check;
ALTER TABLE folio_imports ADD COLUMN remote_deleted_at timestamptz;

-- +goose Down
ALTER TABLE folio_imports DROP COLUMN remote_deleted_at;
-- NOT VALID: imported refunds (negative amounts) stay where they are; the
-- restored CHECKs guard new rows only.
ALTER TABLE folio_imports ADD CONSTRAINT folio_imports_remote_amount_cents_check CHECK (remote_amount_cents >= 0) NOT VALID;
ALTER TABLE other_income ADD CONSTRAINT other_income_amount_cents_check CHECK (amount_cents >= 0) NOT VALID;
ALTER TABLE other_income DROP CONSTRAINT other_income_category_check;
ALTER TABLE other_income ADD CONSTRAINT other_income_category_check CHECK (category IN (
  'uncategorized', 'sales_deposit', 'honey_sales', 'colony_sales',
  'product_sales', 'pollination', 'services', 'grant', 'refund', 'other'));
ALTER TABLE expenses ADD CONSTRAINT expenses_amount_cents_check CHECK (amount_cents >= 0) NOT VALID;
