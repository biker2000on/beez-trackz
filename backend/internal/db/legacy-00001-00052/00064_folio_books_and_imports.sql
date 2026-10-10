-- +goose Up
-- Folio book connections and the history import.
--
-- gnucash_books is one row per Folio book Atlas has ever been connected to.
-- The singleton gnucash_sync_settings stays the live configuration of the
-- ACTIVE connection (credentials, cursor, mapping, restore window) and points
-- at its row through active_book_id. Switching books retires the active row
-- (retired_at) and starts a new one; nothing linked to the old row is moved,
-- re-pushed, or pulled again. No credential is stored here: a retired book is
-- read-only history and is never contacted.
--
-- external_sync.book_id records which book a pushed entity lives in. A row
-- with book_id NULL has never been pushed anywhere and goes to whichever book
-- is active when it is.
--
-- other_income is money in that Atlas did not record as a sale: entries
-- imported from Folio (a deposit, a grant, a pre-Atlas honey sale). An entry
-- may name the Atlas sale it is the deposit for, which keeps reports from
-- counting the same revenue twice. It never creates a sale or moves stock.
-- Its amount is signed: a negative entry is money paid back out of an income
-- account (a customer refund or reversal) and reduces other income.
--
-- folio_imports is the pull-side link table, the mirror of external_sync: one
-- row per Folio transaction imported from one book, pointing at the Atlas
-- expense or other_income entry it became, with the remote values last seen
-- (for idempotent re-application of the change feed) and a conflict state.
-- A transaction deleted in Folio is never deleted here silently: it is
-- flagged remote_deleted, whether Folio's change feed reported the deletion
-- (Folio with the transaction-deletions capability) or a full rescan missed it.
--
-- expenses gains the 'uncategorized' category: an imported expense starts
-- there until the operator assigns one. expenses.amount_cents loses its
-- non-negative CHECK: a refund credited to an imported expense account is a
-- NEGATIVE expense (it reduces expense totals, it is not income). Only the
-- import writes one; manual entry (POST /expenses, colony intake cost) still
-- refuses a negative amount in the API. folio_imports.remote_amount_cents is
-- signed for the same reason.
-- Both chains run this same file.
CREATE TABLE gnucash_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  base_url text NOT NULL DEFAULT '',
  book_guid text,
  book_name text,
  root_currency text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- At most one active (unretired) book.
CREATE UNIQUE INDEX gnucash_books_active_key
  ON gnucash_books ((retired_at IS NULL)) WHERE retired_at IS NULL;

CREATE TRIGGER gnucash_books_updated_at BEFORE UPDATE ON gnucash_books
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE gnucash_sync_settings
  ADD COLUMN active_book_id uuid REFERENCES gnucash_books(id) ON DELETE SET NULL,
  ADD COLUMN import_account_guids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN import_start_date date,
  ADD COLUMN import_cursor text,
  ADD COLUMN last_import_at timestamptz;

ALTER TABLE external_sync
  ADD COLUMN book_id uuid REFERENCES gnucash_books(id) ON DELETE RESTRICT;

CREATE INDEX external_sync_book_id_idx ON external_sync (book_id) WHERE book_id IS NOT NULL;

ALTER TABLE expenses DROP CONSTRAINT expenses_category_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_category_check CHECK (category IN (
  'bees_queens', 'feed', 'treatments', 'packaging', 'equipment', 'mileage',
  'market_fees', 'labor', 'other', 'grocery', 'uncategorized'));
ALTER TABLE expenses DROP CONSTRAINT expenses_amount_cents_check;

CREATE TABLE other_income (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  income_date date NOT NULL,
  category text NOT NULL DEFAULT 'uncategorized' CHECK (category IN (
    'uncategorized', 'sales_deposit', 'honey_sales', 'colony_sales',
    'product_sales', 'pollination', 'services', 'grant', 'other')),
  description text NOT NULL,
  amount_cents bigint NOT NULL,
  sale_id uuid REFERENCES sales(id) ON DELETE SET NULL,
  notes text,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  deletion_reason text
);

CREATE INDEX other_income_live_date_idx ON other_income (income_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX other_income_sale_id_idx ON other_income (sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX other_income_created_by_idx ON other_income (created_by);
CREATE INDEX other_income_deleted_by_idx ON other_income (deleted_by);

CREATE TRIGGER other_income_updated_at BEFORE UPDATE ON other_income
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE folio_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES gnucash_books(id) ON DELETE RESTRICT,
  transaction_guid text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('expense', 'income')),
  expense_id uuid REFERENCES expenses(id) ON DELETE CASCADE,
  income_id uuid REFERENCES other_income(id) ON DELETE CASCADE,
  account_guids jsonb NOT NULL DEFAULT '[]'::jsonb,
  remote_post_date date,
  remote_enter_date timestamptz,
  remote_description text NOT NULL DEFAULT '',
  remote_amount_cents bigint NOT NULL,
  -- When Folio last reported this transaction deleted (its deletion-stream
  -- deletedAt, or the time a full scan missed it). A re-delivered report of
  -- the same deletion is not raised again after the operator kept the entry;
  -- cleared when the transaction is seen alive.
  remote_deleted_at timestamptz,
  state text CHECK (state IS NULL OR state IN ('remote_changed', 'remote_deleted', 'unrepresentable')),
  message text,
  pending jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT folio_imports_entity_matches_direction CHECK (
    (direction = 'expense' AND expense_id IS NOT NULL AND income_id IS NULL)
    OR (direction = 'income' AND income_id IS NOT NULL AND expense_id IS NULL))
);

CREATE UNIQUE INDEX folio_imports_book_transaction_key ON folio_imports (book_id, transaction_guid);
CREATE UNIQUE INDEX folio_imports_expense_key ON folio_imports (expense_id) WHERE expense_id IS NOT NULL;
CREATE UNIQUE INDEX folio_imports_income_key ON folio_imports (income_id) WHERE income_id IS NOT NULL;
CREATE INDEX folio_imports_state_idx ON folio_imports (state) WHERE state IS NOT NULL;

CREATE TRIGGER folio_imports_updated_at BEFORE UPDATE ON folio_imports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The existing configuration becomes the first, active book connection, and
-- every entity already linked to a Folio transaction is linked to it. Rows
-- that were never pushed (no external id, no remote guid) stay unassigned.
INSERT INTO gnucash_books (label, base_url, book_guid, book_name, root_currency, connected_at)
SELECT COALESCE(NULLIF(btrim(s.book_name), ''), 'Folio book'), s.base_url, s.book_guid,
       s.book_name, s.root_currency, s.created_at
FROM gnucash_sync_settings s
WHERE s.id
  AND (s.book_guid IS NOT NULL
       OR EXISTS (SELECT 1 FROM external_sync es
                  WHERE es.system = 'gnucash_web'
                    AND (es.external_id IS NOT NULL OR es.remote_transaction_guid IS NOT NULL)));

UPDATE gnucash_sync_settings
SET active_book_id = (SELECT b.id FROM gnucash_books b WHERE b.retired_at IS NULL)
WHERE id;

UPDATE external_sync
SET book_id = (SELECT b.id FROM gnucash_books b WHERE b.retired_at IS NULL)
WHERE system = 'gnucash_web'
  AND (external_id IS NOT NULL OR remote_transaction_guid IS NOT NULL);

-- +goose Down
DROP TABLE folio_imports;
DROP TABLE other_income;
-- NOT VALID: imported refunds (negative expenses) stay where they are; the
-- restored CHECK guards new rows only.
ALTER TABLE expenses ADD CONSTRAINT expenses_amount_cents_check CHECK (amount_cents >= 0) NOT VALID;
UPDATE expenses SET category = 'other' WHERE category = 'uncategorized';
ALTER TABLE expenses DROP CONSTRAINT expenses_category_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_category_check CHECK (category IN (
  'bees_queens', 'feed', 'treatments', 'packaging', 'equipment', 'mileage',
  'market_fees', 'labor', 'other', 'grocery'));
DROP INDEX IF EXISTS external_sync_book_id_idx;
ALTER TABLE external_sync DROP COLUMN book_id;
ALTER TABLE gnucash_sync_settings
  DROP COLUMN last_import_at,
  DROP COLUMN import_cursor,
  DROP COLUMN import_start_date,
  DROP COLUMN import_account_guids,
  DROP COLUMN active_book_id;
DROP TABLE gnucash_books;
