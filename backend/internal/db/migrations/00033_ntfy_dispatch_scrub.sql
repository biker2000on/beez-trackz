-- +goose Up
-- Dispatch receipts are permanent dedup keys, but the notification text has
-- no reason to live forever. Allow the cleanup job to scrub title/body while
-- keeping the (event_kind, event_key) row.
ALTER TABLE ntfy_dispatches
  ALTER COLUMN title DROP NOT NULL,
  ALTER COLUMN body DROP NOT NULL;

-- +goose Down
UPDATE ntfy_dispatches SET title = '' WHERE title IS NULL;
UPDATE ntfy_dispatches SET body = '' WHERE body IS NULL;
ALTER TABLE ntfy_dispatches
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN body SET NOT NULL;
