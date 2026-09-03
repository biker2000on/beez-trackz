-- +goose Up
-- Optional login name so an SSO account without email can still use a password.
ALTER TABLE app_users ADD COLUMN username text;
CREATE UNIQUE INDEX app_users_username_lower_idx ON app_users (lower(username))
  WHERE username IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS app_users_username_lower_idx;
ALTER TABLE app_users DROP COLUMN username;
