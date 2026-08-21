-- +goose Up
ALTER TABLE user_settings
  ADD COLUMN ntfy_access_token text;

COMMENT ON COLUMN user_settings.ntfy_access_token IS
  'Optional bearer token for reserved or protected ntfy topics.';

-- +goose Down
ALTER TABLE user_settings
  DROP COLUMN IF EXISTS ntfy_access_token;
