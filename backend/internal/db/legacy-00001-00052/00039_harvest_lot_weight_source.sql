-- +goose Up
-- Record whether a lot's honey weight was typed or derived from its harvests.
--
-- harvest_lots.honey_weight_lbs is the bottling ceiling, yet it was always
-- free-typed even when the lot already had linked harvests whose summed
-- calculated_honey_weight is the authoritative number (the same SUM the
-- product and business-report readers already use). A typo there silently
-- raised or lowered how much honey the operation believes it has.
--
-- 'manual' is the default so every existing row keeps its typed weight and
-- its honey_weight_entered sidecar (00026) unchanged.

ALTER TABLE harvest_lots
  ADD COLUMN honey_weight_source text NOT NULL DEFAULT 'manual'
    CHECK (honey_weight_source IN ('manual', 'derived'));

-- +goose Down
ALTER TABLE harvest_lots
  DROP COLUMN IF EXISTS honey_weight_source;
