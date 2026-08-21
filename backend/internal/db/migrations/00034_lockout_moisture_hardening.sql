-- +goose Up
-- 1. Moisture override tier. Above the refractometer threshold a lot was a
--    hard reject with no way through, so an operator with a legitimate reason
--    (dehumidifier run scheduled, blend target, bakery/mead sale that does not
--    care) had to falsify the reading. Keep the hard reject as the default and
--    add an explicit, attributed override instead: reason + who + when, so the
--    exception is on the record rather than hidden in a fudged number.
ALTER TABLE harvest_lots
  ADD COLUMN moisture_override_reason text,
  ADD COLUMN moisture_override_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN moisture_override_at timestamptz,
  -- The three move together: an override is never anonymous or undated, and a
  -- cleared override leaves nothing behind.
  ADD CONSTRAINT harvest_lots_moisture_override_complete CHECK (
    (moisture_override_reason IS NULL AND moisture_override_at IS NULL)
    OR (moisture_override_reason IS NOT NULL
        AND btrim(moisture_override_reason) <> ''
        AND moisture_override_at IS NOT NULL)
  );

COMMENT ON COLUMN harvest_lots.moisture_override_reason IS
  'Why an over-threshold moisture reading was accepted. NULL = no override; the reading was within threshold or the lot was refused.';

-- 2. Treatment withdrawal catalog audit against product labels.
--
--    00019 seeded every product at 0 days, which makes the lockout a no-op the
--    moment a treatment is marked removed. 00022 corrected Apivar 14,
--    CheckMite+ 14 and ApiLife Var 30. The remaining seeded products were
--    re-checked against their labels and 0 is correct for all four, because
--    none of them state a post-removal interval before honey supers may go
--    back on -- their restriction is "no supers while treating", which the
--    date_applied/date_removed lock already enforces:
--
--      Apiguard (thymol gel)     label: remove honey supers before treating;
--                                no post-removal interval stated => 0.
--      Formic Pro (formic acid)  label explicitly allows honey supers to stay
--                                on during treatment => 0.
--      Oxalic acid (dribble or   label: not for use when honey supers are in
--        vapor, incl. Api-Bioxal) place; no post-removal interval => 0.
--      HopGuard 3 (hops beta     label allows use with honey supers on; no
--        acids)                  withdrawal stated => 0.
--
--    They are already 0 from 00019, so this only annotates the notes column
--    with the label basis, and only where the operator has not edited the row
--    (still 0 days and never updated). Operator edits win.
UPDATE treatment_products SET
  notes = CASE WHEN notes IS NULL OR btrim(notes) = '' THEN v.note ELSE notes || ' ' || v.note END
FROM (VALUES
  ('apiguard',
   'Label basis: remove honey supers before treating; no post-removal interval stated, so 0 days after removal.'),
  ('formic pro',
   'Label basis: honey supers may remain on during treatment, so 0 days.'),
  ('oxalic acid',
   'Label basis: not for use with honey supers in place; no post-removal interval stated, so 0 days after the application date.'),
  ('hopguard',
   'Label basis: HopGuard 3 may be used with honey supers on; no withdrawal stated, so 0 days.')
) AS v(name_key, note)
WHERE treatment_products.name_key = v.name_key
  AND treatment_products.withdrawal_days = 0
  AND treatment_products.updated_at = treatment_products.created_at;

-- 3. Products an operator can plausibly record that the catalog did not know
--    about. A missing product resolves to 0 withdrawal days silently
--    (resolveWithdrawalDays returns 0 on no rows), which is the dangerous
--    direction for the antibiotics below. Insert only -- an existing row,
--    matched by name or by alias in either direction, is left exactly as the
--    operator has it.
INSERT INTO treatment_products (name, aliases, withdrawal_days, notes)
SELECT v.name, v.aliases, v.days, v.note
FROM (VALUES
  -- Oxytetracycline for AFB/EFB. Label: discontinue at least 6 weeks (42 days)
  -- before the main honey flow. This is the one that must not default to 0.
  ('Terramycin', ARRAY['oxytetracycline', 'terramycin ts', 'tm-50'], 42,
   'Label basis: discontinue at least 6 weeks (42 days) before the main honey flow.'),
  -- Tylosin tartrate for AFB. Label: at least 4 weeks before the honey flow.
  ('Tylan', ARRAY['tylosin', 'tylosin tartrate'], 28,
   'Label basis: do not use within 4 weeks (28 days) of the main honey flow.'),
  -- Lincomycin for AFB. Label: at least 4 weeks before the honey flow.
  ('Lincomix', ARRAY['lincomycin'], 28,
   'Label basis: do not use within 4 weeks (28 days) of the main honey flow.'),
  -- Fumagillin for nosema. Label: feed with supers off; no post-treatment
  -- interval is stated once supers go back on.
  ('Fumagilin-B', ARRAY['fumagillin', 'fumidil'], 0,
   'Label basis: feed with honey supers off; no post-removal interval stated, so 0 days.'),
  -- Thymol strips. The label restriction is "not during a honey flow / supers
  -- off"; it does not state a post-removal interval. Ambiguous -- defaulting to
  -- the 30 days ApiLife Var carries, the other thymol product in this catalog,
  -- as the conservative documented choice. Lower it if your label says less.
  ('Thymovar', ARRAY['thymol strips'], 30,
   'Label ambiguous on a post-removal interval; conservative default matched to ApiLife Var (thymol, 30 days). Verify against the label in hand.'),
  -- Extended-release oxalic strips. Label: remove before honey supers are
  -- added; no post-removal interval.
  ('VarroxSan', ARRAY['oxalic strips', 'extended release oxalic'], 0,
   'Label basis: remove strips before adding honey supers; no post-removal interval stated, so 0 days.'),
  -- Flumethrin strips, same class as Apistan (00019 seeded that at 0).
  ('Bayvarol', ARRAY['flumethrin'], 0,
   'Label basis: remove strips before honey supers go on; no post-removal interval stated, so 0 days.'),
  -- Paradichlorobenzene for wax moth in STORED comb -- never on a live colony.
  -- No honey withdrawal because it is not applied to a producing hive, but the
  -- comb must be aired before use.
  ('Para-Moth', ARRAY['paradichlorobenzene', 'pdb', 'moth crystals'], 0,
   'Stored-comb fumigant, not a colony treatment: air combs thoroughly before use. No honey withdrawal, so 0 days.'),
  -- Bacillus thuringiensis aizawai for wax moth on stored comb.
  ('Certan', ARRAY['b401', 'b-401', 'bacillus thuringiensis aizawai'], 0,
   'Label basis: no honey withdrawal, so 0 days.')
) AS v(name, aliases, days, note)
WHERE NOT EXISTS (
  SELECT 1 FROM treatment_products p
  WHERE p.name_key = lower(btrim(v.name))
     OR p.name_key = ANY (SELECT lower(btrim(va)) FROM unnest(v.aliases) va)
     OR EXISTS (
       SELECT 1 FROM unnest(p.aliases) pa
       WHERE lower(btrim(pa)) = lower(btrim(v.name))
          OR lower(btrim(pa)) = ANY (SELECT lower(btrim(va)) FROM unnest(v.aliases) va)
     )
);

-- 4. Treatment events written by an inspection are now reconciled when that
--    inspection's treatments jsonb is edited, which needs the link indexed to
--    stay cheap.
CREATE INDEX IF NOT EXISTS treatment_events_inspection_id_idx
  ON treatment_events (inspection_id) WHERE inspection_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS treatment_events_inspection_id_idx;
DELETE FROM treatment_products WHERE name_key IN (
  'terramycin', 'tylan', 'lincomix', 'fumagilin-b', 'thymovar',
  'varroxsan', 'bayvarol', 'para-moth', 'certan'
) AND updated_at = created_at;
ALTER TABLE harvest_lots
  DROP CONSTRAINT IF EXISTS harvest_lots_moisture_override_complete,
  DROP COLUMN IF EXISTS moisture_override_at,
  DROP COLUMN IF EXISTS moisture_override_by,
  DROP COLUMN IF EXISTS moisture_override_reason;
