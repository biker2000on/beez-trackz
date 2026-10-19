/**
 * Unit coverage for the Today roll-up rules (`features/work/rollup.ts`):
 * one card per hive, priority → bucket, the stale rule read from the item's
 * own "N days", and the primary action.
 *
 * Imports the real module directly — Node's built-in TypeScript type
 * stripping means the test exercises the shipped code, not a copy of it.
 *
 * Run: node --test tests/unit/work-rollup.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  STALE_AFTER_DAYS,
  bucketCards,
  cardSummary,
  evidenceAgeDays,
  isFieldActionable,
  isRetired,
  isStale,
  rollUp,
  rosterOf,
} from "../../src/features/work/rollup.ts";

const AS_OF = "2026-09-03T12:00:00Z";

function item(overrides = {}) {
  return {
    id: overrides.id ?? "wi:1",
    sourceType: "recommendation",
    sourceId: "src",
    context: {
      apiaryId: "ap",
      apiaryName: "North Ridge",
      hiveId: "h1",
      hiveName: "A3",
      locationId: null,
    },
    title: "Inspect this hive",
    evidence: [
      { text: "No inspection recorded in 31 days", sourceType: "recommendation", sourceId: "src", observedAt: "2026-09-01T09:00:00Z" },
    ],
    priority: "high",
    status: "open",
    dueAt: null,
    supersedes: [],
    asOf: AS_OF,
    freshness: { origin: "server", cachedAt: null, stale: false },
    commands: [],
    sortRank: 2,
    ...overrides,
  };
}

test("the age is the largest 'N days' the item states about itself", () => {
  const feeder = item({
    title: "Check the feeder",
    evidence: [{ text: "Feeder on hive C2 placed 724 days ago. Check if empty.", sourceType: "recommendation", sourceId: "s", observedAt: "2026-08-11T20:00:00Z" }],
  });
  assert.equal(evidenceAgeDays(feeder, AS_OF), 724);
  assert.equal(isStale(feeder, AS_OF), true);

  const treatment = item({
    title: "Review treatment",
    evidence: [{ text: "Treatment X may need follow-up. Applied 30 days ago (estimated 7-day duration).", sourceType: "recommendation", sourceId: "s", observedAt: null }],
  });
  // "7-day" is not "7 days": the stated age is 30.
  assert.equal(evidenceAgeDays(treatment, AS_OF), 30);
  assert.equal(isStale(treatment, AS_OF), false);
});

test("without a stated age the observation date decides, and no date means fresh", () => {
  // (Not an inspection item: those are never stale, see the test below.)
  const dated = item({
    title: "Pull honey",
    evidence: [{ text: "Stores heavy", sourceType: "harvest_ready", sourceId: "s", observedAt: "2025-09-01T00:00:00Z" }],
  });
  assert.ok(evidenceAgeDays(dated, AS_OF) >= STALE_AFTER_DAYS);
  assert.equal(isStale(dated, AS_OF), true);

  const undated = item({
    evidence: [{ text: "Hive A3 has never had a mite count. Sample soon.", sourceType: "recommendation", sourceId: "s", observedAt: null }],
  });
  assert.equal(evidenceAgeDays(undated, AS_OF), null);
  assert.equal(isStale(undated, AS_OF), false);
});

test("one card per hive, in the server's order, with the highest priority", () => {
  const items = [
    item({ id: "a", priority: "high", title: "Inspect this hive" }),
    item({ id: "b", context: { apiaryId: "ap", apiaryName: "North Ridge", hiveId: "h2", hiveName: "B1", locationId: null }, priority: "normal", title: "Pull honey" }),
    item({ id: "c", priority: "urgent", title: "Check the feeder", evidence: [{ text: "Feeder placed 12 days ago", sourceType: "feeding", sourceId: "f", observedAt: null }] }),
  ];
  const { cards, staleCount } = rollUp(items, AS_OF, { showStale: false });
  assert.equal(staleCount, 0);
  assert.deepEqual(cards.map((card) => card.hiveName), ["A3", "B1"]);
  assert.equal(cards[0].priority, "urgent");
  assert.equal(cards[0].bucket, "urgent");
  assert.deepEqual(cards[0].items.map((entry) => entry.id), ["a", "c"]);
  assert.equal(cards[1].bucket, "later");
  // The top item names the primary action.
  assert.equal(cards[0].primary, "log-inspection");
  assert.equal(cards[1].primary, "open-hive");
  assert.equal(cardSummary(cards[0]), "Inspect this hive · 31 d  ·  Check the feeder · 12 d");

  const sections = bucketCards(cards);
  assert.deepEqual(sections.map((section) => [section.label, section.cards.length]), [
    ["Urgent", 1],
    ["Later", 1],
  ]);
});

test("an item asking for an inspection is never stale, however old the gap", () => {
  const gap = item({
    title: "Inspect this hive",
    evidence: [{ text: "No inspection recorded in 324 days", sourceType: "recommendation", sourceId: "s", observedAt: "2025-01-01T00:00:00Z" }],
  });
  assert.equal(evidenceAgeDays(gap, AS_OF), 324);
  assert.equal(isStale(gap, AS_OF), false);
  const overdue = item({
    title: "Overdue inspection",
    evidence: [{ text: "Last looked at 400 days ago", sourceType: "recommendation", sourceId: "s", observedAt: null }],
  });
  assert.equal(isStale(overdue, AS_OF), false);
  const { cards, staleCount } = rollUp([gap], AS_OF, { showStale: false });
  assert.equal(staleCount, 0);
  assert.deepEqual(cards.map((card) => card.primary), ["log-inspection"]);
});

test("stale items hide, and a card with nothing left is dropped", () => {
  const items = [
    item({ id: "fresh" }),
    item({
      id: "old",
      title: "Check the feeder",
      context: { apiaryId: "ap", apiaryName: "North Ridge", hiveId: "h3", hiveName: "C2", locationId: null },
      evidence: [{ text: "Feeder placed 724 days ago", sourceType: "recommendation", sourceId: "s", observedAt: null }],
    }),
  ];
  const hidden = rollUp(items, AS_OF, { showStale: false });
  assert.equal(hidden.staleCount, 1);
  assert.deepEqual(hidden.cards.map((card) => card.hiveName), ["A3"]);

  const shown = rollUp(items, AS_OF, { showStale: true });
  assert.equal(shown.staleCount, 1);
  assert.deepEqual(shown.cards.map((card) => card.hiveName), ["A3", "C2"]);
});

test("the Visit queue keeps what can be done at a hive", () => {
  assert.equal(isFieldActionable(item()), true);
  assert.equal(isFieldActionable(item({ sourceType: "lockout" })), false);
  assert.equal(
    isFieldActionable(item({ context: { apiaryId: null, apiaryName: null, hiveId: null, hiveName: null, locationId: null } })),
    false,
  );
});

test("items on sold, dead, combined or archived hives are dropped; unknown hives are kept", () => {
  // The QA copy: A1 and C2 are sold (not archived), "B2 (N1)" is a dead,
  // archived nuc, B4 is active. A hive the roster does not list is kept.
  const roster = rosterOf([
    { id: "sold", status: "sold", isArchived: false },
    { id: "nuc", status: "dead", isArchived: true },
    { id: "combined", status: "combined", isArchived: true },
    { id: "active", status: "active", isArchived: false },
  ]);
  const ctx = (hiveId, hiveName) => ({ apiaryId: "ap", apiaryName: "Lenoir Apiary", hiveId, hiveName, locationId: null });
  const items = [
    item({ id: "a", context: ctx("sold", "A1") }),
    item({ id: "b", context: ctx("nuc", "B2 (N1)") }),
    item({ id: "c", context: ctx("combined", "A3") }),
    item({ id: "d", context: ctx("active", "B4") }),
    item({ id: "e", context: ctx("unlisted", "E1") }),
    item({ id: "f", context: ctx(null, null), title: "Order supers" }),
  ];
  assert.equal(isRetired(items[0], roster), true);
  assert.equal(isRetired(items[1], roster), true);
  assert.equal(isRetired(items[3], roster), false);
  assert.equal(isRetired(items[4], roster), false);
  assert.equal(isRetired(items[5], roster), false);
  // No roster yet: nothing is judged.
  assert.equal(isRetired(items[0], undefined), false);

  const { cards, retiredCount } = rollUp(items, AS_OF, { showStale: false, roster });
  assert.equal(retiredCount, 3);
  assert.deepEqual(cards.map((card) => card.hiveName ?? card.items[0].title), ["B4", "E1", "Order supers"]);

  const unfiltered = rollUp(items, AS_OF, { showStale: false });
  assert.equal(unfiltered.retiredCount, 0);
  assert.equal(unfiltered.cards.length, 6);
});
