-- +goose Up
-- The varietal is the honey's name. harvest_lots.honey_variety was the
-- free-text label that 00047 seeded honey_varietals from and then left in
-- place "as the label copy"; since then the two have been able to disagree,
-- and the customer-facing readers (public Honey Story title, serial lookup,
-- compliance packet, workbench) read the free text while the varietals page
-- read the join. One name, one place: harvest_lots.varietal_id ->
-- honey_varietals.name.
--
-- Backfill first so no typed name is lost: a lot with no varietal but a
-- non-blank honey_variety gets the varietal whose name matches
-- case-insensitively, creating that varietal when none exists. A lot that
-- already names a varietal keeps it even where the free text differed —
-- the varietal was the operator's later, deliberate choice.
INSERT INTO honey_varietals (name)
SELECT DISTINCT ON (lower(btrim(l.honey_variety))) btrim(l.honey_variety)
FROM harvest_lots l
WHERE l.varietal_id IS NULL
  AND btrim(COALESCE(l.honey_variety, '')) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM honey_varietals v
    WHERE lower(v.name) = lower(btrim(l.honey_variety))
  )
ORDER BY lower(btrim(l.honey_variety)), btrim(l.honey_variety);

UPDATE harvest_lots l
SET varietal_id = v.id
FROM honey_varietals v
WHERE l.varietal_id IS NULL
  AND btrim(COALESCE(l.honey_variety, '')) <> ''
  AND lower(btrim(l.honey_variety)) = lower(v.name);

-- The 00047 views project honey_variety. They exist only on the legacy
-- chain (the baseline squash dropped them with honey_movements), so they are
-- dropped unconditionally here and recreated — minus the column, otherwise
-- unchanged — only where honey_movements still exists. Both chains run this
-- same file.
DROP VIEW IF EXISTS honey_varietal_balances;
DROP VIEW IF EXISTS honey_lot_balances;

ALTER TABLE harvest_lots DROP COLUMN honey_variety;

-- +goose StatementBegin
DO $$
BEGIN
  IF to_regclass('public.honey_movements') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE $view$
    CREATE VIEW honey_lot_balances AS
    SELECT
      l.id AS lot_id,
      l.lot_code,
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
    ) draws ON draws.lot_id = l.id
  $view$;
  EXECUTE $view$
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
    GROUP BY v.id, v.name
  $view$;
END
$$;
-- +goose StatementEnd

-- +goose Down
DROP VIEW IF EXISTS honey_varietal_balances;
DROP VIEW IF EXISTS honey_lot_balances;

ALTER TABLE harvest_lots ADD COLUMN honey_variety text;

UPDATE harvest_lots l
SET honey_variety = v.name
FROM honey_varietals v
WHERE v.id = l.varietal_id;

-- +goose StatementBegin
DO $$
BEGIN
  IF to_regclass('public.honey_movements') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE $view$
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
    ) draws ON draws.lot_id = l.id
  $view$;
  EXECUTE $view$
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
    GROUP BY v.id, v.name
  $view$;
END
$$;
-- +goose StatementEnd
