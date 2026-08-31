-- +goose Up
-- Equipment bill of materials: a parent type is built from component types
-- (a honey super = 1 box + 9 frames, a built frame = 1 frame + 1 foundation).
--
-- The BOM is pure catalog data; assembling or disassembling writes ordinary
-- ownership-ledger adjustments ('assembled' / 'disassembled') against the
-- parent and every component, so the migration-00006 reconciliation guard and
-- availability formula keep working unchanged.

-- Postgres forbids using a new enum value in the transaction that adds it, so
-- these are only added here; the handlers are the first writers.
ALTER TYPE stock_adjustment_reason ADD VALUE IF NOT EXISTS 'assembled';
ALTER TYPE stock_adjustment_reason ADD VALUE IF NOT EXISTS 'disassembled';

-- Varieties: a type may declare itself a variant of a base type (migratory
-- cover vs telescoping cover; basic vs complicated frame build). A variant is
-- a full type — its own stock row, cost, and bill of materials — the base
-- type only groups them. One level deep, enforced by the handlers; deleting a
-- base type promotes its variants to top level rather than orphaning them.
ALTER TABLE equipment_types
  ADD COLUMN variant_of_type_id uuid
    REFERENCES equipment_types(id) ON DELETE SET NULL,
  ADD CONSTRAINT equipment_types_variant_not_self
    CHECK (variant_of_type_id IS NULL OR variant_of_type_id <> id);
CREATE INDEX equipment_types_variant_of_idx
  ON equipment_types (variant_of_type_id);

CREATE TABLE equipment_type_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_type_id uuid NOT NULL
    REFERENCES equipment_types(id) ON DELETE CASCADE,
  component_type_id uuid NOT NULL
    REFERENCES equipment_types(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  UNIQUE (parent_type_id, component_type_id),
  CHECK (parent_type_id <> component_type_id)
);
CREATE TRIGGER equipment_type_components_updated_at
  BEFORE UPDATE ON equipment_type_components
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX equipment_type_components_component_idx
  ON equipment_type_components (component_type_id);

-- A BOM line that would let a type (transitively) contain itself makes
-- assembly cost and availability undecidable, so the database refuses it.
-- +goose StatementBegin
CREATE FUNCTION equipment_component_cycle_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE ancestry AS (
      SELECT NEW.parent_type_id AS type_id
      UNION
      SELECT c.parent_type_id
      FROM equipment_type_components c
      JOIN ancestry a ON a.type_id = c.component_type_id
    )
    SELECT 1 FROM ancestry WHERE type_id = NEW.component_type_id
  ) THEN
    RAISE EXCEPTION 'component % would create a cycle', NEW.component_type_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER equipment_type_components_cycle_guard
  BEFORE INSERT OR UPDATE ON equipment_type_components
  FOR EACH ROW EXECUTE FUNCTION equipment_component_cycle_guard();

-- +goose Down
DROP TRIGGER IF EXISTS equipment_type_components_cycle_guard
  ON equipment_type_components;
DROP FUNCTION IF EXISTS equipment_component_cycle_guard();
DROP TABLE IF EXISTS equipment_type_components;
ALTER TABLE equipment_types
  DROP CONSTRAINT IF EXISTS equipment_types_variant_not_self,
  DROP COLUMN IF EXISTS variant_of_type_id;
-- 'assembled' / 'disassembled' stay on stock_adjustment_reason (Postgres
-- cannot drop an enum value).
