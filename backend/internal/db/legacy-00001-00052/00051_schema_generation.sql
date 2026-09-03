-- +goose Up
-- The schema generation stamp (design review A6, spec section 9 step 7).
--
-- Goose answers "which migrations have run", not "is this the schema this
-- binary was built for". After the Phase B squash the two questions diverge:
-- a database still sitting at version 49 of the OLD chain looks perfectly
-- healthy to `goose up` against the NEW chain — the new 00001_baseline is
-- already recorded as applied, so goose reports "no migrations to run" and
-- the process happily serves a schema that predates the ledger.
--
-- The stamp closes that hole. A database carrying this table is a member of
-- a named generation; a database that predates this migration carries no
-- table at all and is classified 'legacy' by internal/db/generation.go. Both
-- classifications are checked at every entry point, so the only ways to run
-- against a foreign schema are the explicit, read-only --legacy-source path
-- and a deliberate DROP.
--
-- The table is deliberately tiny and deliberately keyed on the generation
-- itself: exactly one row is expected, and a second row (two generations
-- claimed at once) is as much a failure as none.
CREATE TABLE schema_generation (
  generation text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE schema_generation IS
  'Exactly one row naming the schema generation this database belongs to. Checked by internal/db.CheckGeneration at every entry point; a database with no such table is generation "legacy".';

INSERT INTO schema_generation (generation) VALUES ('ledger-v1');

-- +goose Down
DROP TABLE IF EXISTS schema_generation;
