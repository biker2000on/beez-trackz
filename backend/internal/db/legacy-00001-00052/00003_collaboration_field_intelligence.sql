-- +goose Up
-- Apiary-scoped collaboration, offline idempotency, API tokens, and weather
-- caching. Existing identities are promoted to administrators so the migration
-- never removes access from an owner who could use the single-user application.

CREATE TYPE apiary_access_role AS ENUM ('viewer', 'editor');

CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject text UNIQUE,
  display_name text,
  email text,
  is_admin boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_users_email_lower_idx ON app_users (lower(email))
  WHERE email IS NOT NULL;
CREATE TRIGGER app_users_updated_at BEFORE UPDATE ON app_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE apiary_memberships (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  apiary_id uuid NOT NULL REFERENCES apiaries(id) ON DELETE CASCADE,
  role apiary_access_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, apiary_id)
);
CREATE INDEX apiary_memberships_apiary_idx ON apiary_memberships (apiary_id);
CREATE TRIGGER apiary_memberships_updated_at BEFORE UPDATE ON apiary_memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE oidc_identities ADD COLUMN user_id uuid REFERENCES app_users(id) ON DELETE SET NULL;
CREATE INDEX oidc_identities_user_idx ON oidc_identities (user_id);

-- Preserve the local-password owner, even on OIDC-only instances where the
-- password hash is NULL. Only an actually configured password can use it.
INSERT INTO app_users (auth_subject, display_name, is_admin)
SELECT 'password', display_name, true
FROM user_settings
WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE auth_subject = 'password')
LIMIT 1;

-- Preserve every identity that had full access before apiary permissions.
INSERT INTO app_users (auth_subject, display_name, email, is_admin)
SELECT 'oidc:' || issuer || ':' || subject, display_name, email, true
FROM oidc_identities identity
WHERE NOT EXISTS (
  SELECT 1 FROM app_users user_row
  WHERE user_row.auth_subject = 'oidc:' || identity.issuer || ':' || identity.subject
     OR (identity.email IS NOT NULL AND lower(user_row.email) = lower(identity.email))
)
ON CONFLICT DO NOTHING;

UPDATE oidc_identities identity
SET user_id = user_row.id
FROM app_users user_row
WHERE user_row.auth_subject = 'oidc:' || identity.issuer || ':' || identity.subject
   OR (identity.email IS NOT NULL AND lower(user_row.email) = lower(identity.email));

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  last_used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);

CREATE TABLE offline_mutation_receipts (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  mutation_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'processing' CHECK (state IN ('processing', 'complete')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mutation_id)
);
CREATE INDEX offline_mutation_receipts_created_idx
  ON offline_mutation_receipts (created_at);
CREATE TRIGGER offline_mutation_receipts_updated_at
  BEFORE UPDATE ON offline_mutation_receipts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE photos ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER photos_updated_at BEFORE UPDATE ON photos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE inspections ADD COLUMN weather_snapshot jsonb;

CREATE TABLE apiary_weather_cache (
  apiary_id uuid PRIMARY KEY REFERENCES apiaries(id) ON DELETE CASCADE,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  forecast jsonb NOT NULL,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

-- +goose Down
DROP TABLE IF EXISTS apiary_weather_cache;
ALTER TABLE inspections DROP COLUMN IF EXISTS weather_snapshot;
DROP TRIGGER IF EXISTS photos_updated_at ON photos;
ALTER TABLE photos DROP COLUMN IF EXISTS updated_at;
DROP TABLE IF EXISTS offline_mutation_receipts;
DROP TABLE IF EXISTS api_tokens;
ALTER TABLE oidc_identities DROP COLUMN IF EXISTS user_id;
DROP TABLE IF EXISTS apiary_memberships;
DROP TABLE IF EXISTS app_users;
DROP TYPE IF EXISTS apiary_access_role;
