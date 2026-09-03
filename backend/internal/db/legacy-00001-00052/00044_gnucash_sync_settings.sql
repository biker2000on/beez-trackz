-- +goose Up
-- Live GnuCash (folio) sync configuration. One row: the operator points beez
-- at one folio book with one personal access token, and every push/pull runs
-- against that book. A second book would be a second beez install.
--
-- The token is stored as the operator pasted it (same treatment as
-- user_settings.ntfy_access_token). It is never returned by the API — reads
-- expose only whether one is present.
--
-- account_mapping holds folio account GUIDs keyed by what they fund:
--   {"revenue": {"jar": guid, "colony": guid, "equipment": guid,
--                "creamed_honey": guid, "hot_honey": guid, "mead": guid,
--                "propolis": guid, "tincture": guid},
--    "expenses": {"bees_queens": guid, ..., "grocery": guid},
--    "cash": guid, "accountsReceivable": guid, "salesTax": guid,
--    "discount": guid, "cogs": guid, "inventory": guid}
-- The keys are the sale_items.kind and expenses.category CHECK lists, so a
-- new kind shows up as an unmapped-kind sync failure rather than silently
-- posting to the wrong account.

CREATE TABLE gnucash_sync_settings (
  -- Singleton: the only allowed primary key is true.
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  base_url text NOT NULL DEFAULT '',
  api_token text,
  book_guid text,
  book_name text,
  root_currency text,
  changes_cursor text,
  sync_enabled boolean NOT NULL DEFAULT false,
  account_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER gnucash_sync_settings_updated_at BEFORE UPDATE ON gnucash_sync_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN gnucash_sync_settings.api_token IS
  'folio personal access token (gcw_…). Never returned by the API.';
COMMENT ON COLUMN gnucash_sync_settings.changes_cursor IS
  'Opaque cursor from GET changes. Persisted only after a page is processed.';

-- +goose Down
DROP TABLE IF EXISTS gnucash_sync_settings;
