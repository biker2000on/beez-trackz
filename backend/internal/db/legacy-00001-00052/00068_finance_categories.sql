-- +goose Up
-- Expense and income categories become operator-managed data instead of a
-- CHECK list.
--
-- finance_categories holds both kinds, one row per (kind, key). key is the
-- stable slug stored in expenses.category / other_income.category and in the
-- Folio account mapping (gnucash_sync_settings.account_mapping.expenses); it
-- never changes once created (finance_categories_guard). label is what the UI
-- shows and can be renamed freely. An archived category stays valid on the
-- rows that already carry it and still displays, but is no longer offered
-- for new entries.
--
-- System rows are the keys code depends on: 'uncategorized' (both kinds —
-- the Folio history import files everything there first), 'sales_deposit'
-- (income — the sale linker and the reports' double-count guard) and
-- 'bees_queens' (expense — colony intake writes it and the colony cost basis
-- sums it). They can be renamed but never archived or deleted; the API
-- refuses, and the CHECK below keeps a system row from being archived.
--
-- Integrity. The CHECK constraints on expenses.category and
-- other_income.category are dropped rather than replaced by a foreign key:
-- a FK on (kind, key) would need a kind column on expenses and other_income
-- (a generated constant column changes both exported record shapes, and the
-- snapshot restore would then have to order finance_categories ahead of every
-- older artifact's expenses). Instead every application write path validates
-- the key against this table under FOR KEY SHARE, which blocks a concurrent
-- delete of that category until the write commits, and a delete trigger
-- refuses to remove a category any expense or income row (soft-deleted rows
-- included) still names. So a stored category always resolves to a row here.
--
-- The seeds use fixed ids so the same category has the same id in every
-- database (and the snapshot importer can declare them for an artifact that
-- predates this table). Both chains run this same file.
CREATE TABLE finance_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('expense', 'income')),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  label text NOT NULL CHECK (btrim(label) <> '' AND length(label) <= 80),
  sort_order integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  is_system boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_categories_kind_key_key UNIQUE (kind, key),
  CONSTRAINT finance_categories_system_not_archived CHECK (NOT (is_system AND archived_at IS NOT NULL))
);

-- One label per kind, ignoring case and surrounding blanks: two "Fuel"
-- categories would be indistinguishable in every picker.
CREATE UNIQUE INDEX finance_categories_label_key
  ON finance_categories (kind, lower(btrim(label)));

CREATE TRIGGER finance_categories_updated_at BEFORE UPDATE ON finance_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +goose StatementBegin
CREATE FUNCTION finance_categories_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.kind <> OLD.kind OR NEW.key <> OLD.key THEN
      RAISE EXCEPTION 'finance category %/% cannot change its kind or key', OLD.kind, OLD.key
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.kind = 'expense' AND EXISTS (SELECT 1 FROM expenses WHERE category = OLD.key) THEN
    RAISE EXCEPTION 'expense category % is still used by an expense', OLD.key
      USING ERRCODE = '23503';
  END IF;
  IF OLD.kind = 'income' AND EXISTS (SELECT 1 FROM other_income WHERE category = OLD.key) THEN
    RAISE EXCEPTION 'income category % is still used by an income entry', OLD.key
      USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER finance_categories_guard BEFORE UPDATE OR DELETE ON finance_categories
  FOR EACH ROW EXECUTE FUNCTION finance_categories_guard();

INSERT INTO finance_categories (id, kind, key, label, sort_order, is_system) VALUES
  ('00000000-0000-0000-0000-000000000301', 'expense', 'bees_queens', 'Bees and queens', 10, true),
  ('00000000-0000-0000-0000-000000000302', 'expense', 'feed', 'Feed', 20, false),
  ('00000000-0000-0000-0000-000000000303', 'expense', 'treatments', 'Treatments', 30, false),
  ('00000000-0000-0000-0000-000000000304', 'expense', 'packaging', 'Packaging', 40, false),
  ('00000000-0000-0000-0000-000000000305', 'expense', 'equipment', 'Equipment', 50, false),
  ('00000000-0000-0000-0000-000000000306', 'expense', 'mileage', 'Mileage', 60, false),
  ('00000000-0000-0000-0000-000000000307', 'expense', 'market_fees', 'Market fees', 70, false),
  ('00000000-0000-0000-0000-000000000308', 'expense', 'labor', 'Labor', 80, false),
  ('00000000-0000-0000-0000-000000000309', 'expense', 'other', 'Other', 90, false),
  ('00000000-0000-0000-0000-000000000310', 'expense', 'grocery', 'Grocery', 100, false),
  ('00000000-0000-0000-0000-000000000311', 'expense', 'uncategorized', 'Uncategorized', 0, true),
  ('00000000-0000-0000-0000-000000000351', 'income', 'uncategorized', 'Uncategorized', 0, true),
  ('00000000-0000-0000-0000-000000000352', 'income', 'sales_deposit', 'Sales deposit', 10, true),
  ('00000000-0000-0000-0000-000000000353', 'income', 'honey_sales', 'Honey sales', 20, false),
  ('00000000-0000-0000-0000-000000000354', 'income', 'colony_sales', 'Colony sales', 30, false),
  ('00000000-0000-0000-0000-000000000355', 'income', 'product_sales', 'Product sales', 40, false),
  ('00000000-0000-0000-0000-000000000356', 'income', 'pollination', 'Pollination', 50, false),
  ('00000000-0000-0000-0000-000000000357', 'income', 'services', 'Services', 60, false),
  ('00000000-0000-0000-0000-000000000358', 'income', 'grant', 'Grant', 70, false),
  ('00000000-0000-0000-0000-000000000359', 'income', 'other', 'Other', 80, false);

ALTER TABLE expenses DROP CONSTRAINT expenses_category_check;
ALTER TABLE other_income DROP CONSTRAINT other_income_category_check;

-- +goose Down
-- NOT VALID: rows filed under a category added after this migration keep it;
-- the restored CHECKs guard new rows only.
ALTER TABLE other_income ADD CONSTRAINT other_income_category_check CHECK (category IN (
  'uncategorized', 'sales_deposit', 'honey_sales', 'colony_sales',
  'product_sales', 'pollination', 'services', 'grant', 'other')) NOT VALID;
ALTER TABLE expenses ADD CONSTRAINT expenses_category_check CHECK (category IN (
  'bees_queens', 'feed', 'treatments', 'packaging', 'equipment', 'mileage',
  'market_fees', 'labor', 'other', 'grocery', 'uncategorized')) NOT VALID;
DROP TABLE finance_categories;
DROP FUNCTION finance_categories_guard();
