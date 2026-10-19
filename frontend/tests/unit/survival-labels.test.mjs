/**
 * Unit coverage for the Winter survival row labels
 * (`features/operations/survival-labels.ts`): stand ids resolve to the
 * apiary layout's stand label, queen-line ids to the root queen's hive,
 * origin and year, and whatever does not resolve is one honest row.
 *
 * Run: node --test tests/unit/survival-labels.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  QUEEN_LINE_UNKNOWN,
  STAND_UNRECORDED,
  originLabel,
  resolveQueenLineRows,
  resolveStandRows,
} from "../../src/features/operations/survival-labels.ts";

const APIARY = "e0bb6f5e-6ea7-4674-bff5-7f47c687df10";
const STAND_B = "84721919-360c-4ff2-8fee-e06ab09e827b";
const STAND_D = "42a6b36f-5cec-4a5c-b339-9d6d1846aa60";

const row = (key, label, entered, survived) => ({
  key,
  label,
  enteredWinter: entered,
  survived,
  survivalRate: entered ? (survived / entered) * 100 : 0,
});

test("stand ids become 'Stand B'; position labels fold into one unrecorded row, last", () => {
  const rows = [
    row(`${APIARY}:${STAND_D}`, `Lenoir Apiary · ${STAND_D}`, 2, 2),
    row(`${APIARY}:A3`, "Lenoir Apiary · A3", 1, 1),
    row(`${APIARY}:${STAND_B}`, `Lenoir Apiary · ${STAND_B}`, 2, 1),
    row(`${APIARY}:Unrecorded (2024 swarm)`, "Lenoir Apiary · Unrecorded (2024 swarm)", 1, 0),
    row(`${APIARY}:C2`, "Lenoir Apiary · C2", 1, 0),
  ];
  const stands = new Map([[APIARY, [{ id: STAND_B, label: "B" }, { id: STAND_D, label: "D" }]]]);
  const names = new Map([[APIARY, "Lenoir Apiary"]]);
  const out = resolveStandRows(rows, stands, names);
  assert.deepEqual(
    out.map((r) => [r.label, r.enteredWinter, r.survived, Math.round(r.survivalRate)]),
    [["Stand D", 2, 2, 100], ["Stand B", 2, 1, 50], [STAND_UNRECORDED, 3, 1, 33]],
  );
  for (const r of out) assert.doesNotMatch(r.label, /[0-9a-f]{8}-/);

  // A second apiary puts the apiary name on the stand rows.
  const other = "11111111-1111-1111-1111-111111111111";
  const two = resolveStandRows(
    [rows[0], row(`${other}:${STAND_B}`, `Ridge · ${STAND_B}`, 1, 1)],
    new Map([[APIARY, [{ id: STAND_D, label: "D" }]], [other, [{ id: STAND_B, label: "B" }]]]),
    new Map([[APIARY, "Lenoir Apiary"], [other, "Ridge"]]),
  );
  assert.deepEqual(two.map((r) => r.label), ["Lenoir Apiary · Stand D", "Ridge · Stand B"]);
});

test("queen lines read as hive · origin queen, year; unknown roots are one row", () => {
  const queens = [
    { id: "q-a4", origin: "emergency_cell", introducedDate: "2026-05-17T00:00:00Z", hiveName: "A4" },
    { id: "q-c4", origin: "unknown", introducedDate: "2024-07-15T00:00:00Z", hiveName: "C4" },
    { id: "q-none", origin: "raised", introducedDate: null, hiveName: null },
  ];
  const rows = [
    row("q-a4", "Emergency Cell line · q-a4", 1, 1),
    row("unknown", "Unknown queen line", 2, 2),
    row("q-c4", "Unknown line · q-c4", 2, 1),
    row("gone", "Unknown line · gone", 1, 0),
    row("q-none", "Raised line · q-none", 1, 1),
  ];
  const out = resolveQueenLineRows(rows, queens);
  assert.deepEqual(
    out.map((r) => [r.label, r.enteredWinter, r.survived]),
    [
      ["A4 · emergency cell queen, 2026", 1, 1],
      ["C4 · queen of unknown origin, 2024", 2, 1],
      ["raised queen", 1, 1],
      [QUEEN_LINE_UNKNOWN, 3, 2],
    ],
  );
  assert.equal(originLabel("swarm"), "swarm queen");
  assert.equal(originLabel(""), "queen of unknown origin");
});
