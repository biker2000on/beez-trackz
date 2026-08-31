-- +goose Up
-- Per-lot bulk honey balances, with varietal as a canonical rollup.
--
-- Bulk honey used to be one undifferentiated pool: wildflower and basswood
-- shared a single number, so "how much basswood is left" had no answer and
-- jarring silently drew from everything at once. A harvest lot is a labelled
-- subset of the harvested pounds, so the model is:
--
--   lot on hand   = harvest_lots.honey_weight_lbs
--                   - SUM(jarring | bulk_use | loss attributed to that lot)
--   unassigned    = (total harvested - SUM(lot weights))
--                   - SUM(draws with no lot)
--   global on hand = SUM(lot on hand) + unassigned
--
-- The last line is the pre-existing global formula, unchanged: attributing a
-- draw to a lot moves it between buckets, it never creates or destroys honey.
-- History carries no attribution and is not guessed at; those rows stay in the
-- unassigned bucket. Handlers require a lot on new draws (see routes_honey.go);
-- the column stays nullable because the past cannot satisfy that rule.

CREATE TABLE honey_varietals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL
);
-- Case-insensitive uniqueness: "Basswood" and "basswood" were three different
-- honeys back when this was free text.
CREATE UNIQUE INDEX honey_varietals_name_key ON honey_varietals (lower(name));
CREATE TRIGGER honey_varietals_updated_at BEFORE UPDATE ON honey_varietals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE harvest_lots
  ADD COLUMN varietal_id uuid REFERENCES honey_varietals(id) ON DELETE SET NULL;
CREATE INDEX harvest_lots_varietal_idx ON harvest_lots (varietal_id)
  WHERE varietal_id IS NOT NULL;

-- Seed the canonical list from what operators already typed, then point each
-- lot at its row. honey_variety is left in place as the free-text label.
INSERT INTO honey_varietals (name)
SELECT DISTINCT ON (lower(btrim(honey_variety))) btrim(honey_variety)
FROM harvest_lots
WHERE honey_variety IS NOT NULL AND btrim(honey_variety) <> ''
ORDER BY lower(btrim(honey_variety)), btrim(honey_variety);

UPDATE harvest_lots l
SET varietal_id = v.id
FROM honey_varietals v
WHERE l.honey_variety IS NOT NULL
  AND lower(btrim(l.honey_variety)) = lower(v.name);

ALTER TABLE honey_movements
  ADD COLUMN lot_id uuid REFERENCES harvest_lots(id) ON DELETE RESTRICT;
CREATE INDEX honey_movements_lot_idx ON honey_movements (lot_id)
  WHERE lot_id IS NOT NULL;

-- Jarring done through a bottling run already knew its lot; carry that across
-- so those rows start attributed rather than sitting in the unassigned pool.
UPDATE honey_movements m
SET lot_id = run.lot_id
FROM bottling_runs run
WHERE m.bottling_run_id = run.id AND m.lot_id IS NULL;

-- A movement that names both a run and a lot must name the same lot, or the
-- balance and the traceability chain would disagree.
-- +goose StatementBegin
CREATE FUNCTION honey_movement_lot_matches_run() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  run_lot uuid;
BEGIN
  IF NEW.bottling_run_id IS NULL OR NEW.lot_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT lot_id INTO run_lot FROM bottling_runs WHERE id = NEW.bottling_run_id;
  IF run_lot IS DISTINCT FROM NEW.lot_id THEN
    RAISE EXCEPTION 'movement lot % does not match bottling run lot %',
      NEW.lot_id, run_lot USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER honey_movements_lot_matches_run
  BEFORE INSERT OR UPDATE ON honey_movements
  FOR EACH ROW EXECUTE FUNCTION honey_movement_lot_matches_run();

-- One row per lot: what it holds, what has been drawn from it, what is left.
CREATE VIEW honey_lot_balances AS
SELECT
  l.id AS lot_id,
  l.lot_code,
  l.honey_variety,
  l.varietal_id,
  v.name AS varietal_name,
  l.extraction_date,
  l.honey_weight_lbs AS lot_lbs,
  COALESCE(draws.jarred_lbs, 0) AS jarred_lbs,
  COALESCE(draws.bulk_used_lbs, 0) AS bulk_used_lbs,
  COALESCE(draws.loss_lbs, 0) AS loss_lbs,
  l.honey_weight_lbs
    - COALESCE(draws.jarred_lbs, 0)
    - COALESCE(draws.bulk_used_lbs, 0)
    - COALESCE(draws.loss_lbs, 0) AS on_hand_lbs
FROM harvest_lots l
LEFT JOIN honey_varietals v ON v.id = l.varietal_id
LEFT JOIN (
  SELECT lot_id,
    COALESCE(SUM(amount_lbs) FILTER (WHERE kind = 'jarring'), 0) AS jarred_lbs,
    COALESCE(SUM(amount_lbs) FILTER (WHERE kind = 'bulk_use'), 0) AS bulk_used_lbs,
    COALESCE(SUM(amount_lbs) FILTER (WHERE kind = 'loss'), 0) AS loss_lbs
  FROM honey_movements
  WHERE lot_id IS NOT NULL
  GROUP BY lot_id
) draws ON draws.lot_id = l.id;

-- The same numbers rolled up to a varietal, which is the question an operator
-- actually asks ("how much basswood do I have?").
CREATE VIEW honey_varietal_balances AS
SELECT
  v.id AS varietal_id,
  v.name AS varietal_name,
  COUNT(b.lot_id) AS lot_count,
  COALESCE(SUM(b.lot_lbs), 0) AS lot_lbs,
  COALESCE(SUM(b.jarred_lbs), 0) AS jarred_lbs,
  COALESCE(SUM(b.bulk_used_lbs), 0) AS bulk_used_lbs,
  COALESCE(SUM(b.loss_lbs), 0) AS loss_lbs,
  COALESCE(SUM(b.on_hand_lbs), 0) AS on_hand_lbs
FROM honey_varietals v
LEFT JOIN honey_lot_balances b ON b.varietal_id = v.id
GROUP BY v.id, v.name;

-- +goose Down
DROP VIEW IF EXISTS honey_varietal_balances;
DROP VIEW IF EXISTS honey_lot_balances;
DROP TRIGGER IF EXISTS honey_movements_lot_matches_run ON honey_movements;
DROP FUNCTION IF EXISTS honey_movement_lot_matches_run();
DROP INDEX IF EXISTS honey_movements_lot_idx;
ALTER TABLE honey_movements DROP COLUMN IF EXISTS lot_id;
DROP INDEX IF EXISTS harvest_lots_varietal_idx;
ALTER TABLE harvest_lots DROP COLUMN IF EXISTS varietal_id;
DROP TABLE IF EXISTS honey_varietals;
