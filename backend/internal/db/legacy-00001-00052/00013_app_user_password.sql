-- +goose Up
-- Per-user password so an SSO account can also sign in with email + password.
ALTER TABLE app_users ADD COLUMN password_hash text;

-- +goose Down
ALTER TABLE app_users DROP COLUMN password_hash;
