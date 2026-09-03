-- +goose Up
-- Display preferences belong to the signed-in user. The singleton keeps only
-- instance-wide policy, authentication material, and integration secrets.
CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  theme text DEFAULT 'system',
  default_apiary_id uuid REFERENCES apiaries(id),
  date_format text DEFAULT 'MM/DD/YYYY',
  weight_unit text DEFAULT 'oz',
  units text CHECK (units IS NULL OR units IN ('metric', 'us')),
  temperature_unit text CHECK (temperature_unit IS NULL OR temperature_unit IN ('c', 'f')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER user_preferences_updated_at BEFORE UPDATE ON user_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO user_preferences (
  user_id, theme, default_apiary_id, date_format, weight_unit, units,
  temperature_unit
)
SELECT
  app_users.id, user_settings.theme, user_settings.default_apiary_id,
  user_settings.date_format, user_settings.weight_unit, user_settings.units,
  user_settings.temperature_unit
FROM app_users
CROSS JOIN user_settings;

ALTER TABLE user_settings
  DROP COLUMN theme,
  DROP COLUMN default_apiary_id,
  DROP COLUMN date_format,
  DROP COLUMN weight_unit,
  DROP COLUMN units,
  DROP COLUMN temperature_unit;

-- +goose Down
ALTER TABLE user_settings
  ADD COLUMN theme text DEFAULT 'system',
  ADD COLUMN default_apiary_id uuid REFERENCES apiaries(id),
  ADD COLUMN date_format text DEFAULT 'MM/DD/YYYY',
  ADD COLUMN weight_unit text DEFAULT 'oz',
  ADD COLUMN units text CHECK (units IS NULL OR units IN ('metric', 'us')),
  ADD COLUMN temperature_unit text CHECK (temperature_unit IS NULL OR temperature_unit IN ('c', 'f'));

UPDATE user_settings
SET theme = chosen.theme,
    default_apiary_id = chosen.default_apiary_id,
    date_format = chosen.date_format,
    weight_unit = chosen.weight_unit,
    units = chosen.units,
    temperature_unit = chosen.temperature_unit
FROM (
  SELECT preferences.*
  FROM user_preferences preferences
  JOIN app_users ON app_users.id = preferences.user_id
  ORDER BY app_users.created_at, app_users.id
  LIMIT 1
) chosen;

DROP TRIGGER IF EXISTS user_preferences_updated_at ON user_preferences;
DROP TABLE user_preferences;
