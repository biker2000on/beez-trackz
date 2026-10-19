/**
 * Unit coverage for `lib/provenance.ts`: every bracketed segment the Obsidian
 * importer wrote (import, identity, queen) leaves the body and becomes a
 * source, and ordinary bracketed notes stay.
 *
 * Run: node --test tests/unit/provenance.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import { splitProvenance } from "../../src/lib/provenance.ts";

test("import and identity segments fold into sources", () => {
  const { body, sources } = splitProvenance(
    "Combined with A2. [Obsidian import:obsidian-history-v3-identity; Journal 2025.md; 2025-09-22; current-D1] [Obsidian identity:obsidian-history-v3-identity; key=current-D1]",
  );
  assert.equal(body, "Combined with A2.");
  assert.deepEqual(
    sources.map((s) => s.label),
    ["Obsidian import", "Obsidian identity"],
  );
});

test("a queen segment is provenance too", () => {
  const { body, sources } = splitProvenance(
    "Swarm queen, marked blue.\n\n[Obsidian queen:obsidian-history-v3-identity; key=q-2026-a1-swarm]",
  );
  assert.equal(body, "Swarm queen, marked blue.");
  assert.equal(sources.length, 1);
  assert.equal(sources[0].label, "Obsidian queen");
  assert.deepEqual(sources[0].parts, [
    "obsidian-history-v3-identity",
    "key=q-2026-a1-swarm",
  ]);
});

test("an operator's own bracketed note is left alone", () => {
  const { body, sources } = splitProvenance("Requeen [see photo: 2026-05-01].");
  assert.equal(body, "Requeen [see photo: 2026-05-01].");
  assert.equal(sources.length, 0);
});
