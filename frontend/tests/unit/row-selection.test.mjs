/**
 * The desktop selection rules the Activity ledger (and any DataGrid given a
 * `selection`) follows. Run: node --test tests/unit/row-selection.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_SELECTION,
  idRange,
  reduceRowSelection,
} from "../../src/lib/row-selection.ts";

const IDS = ["a", "b", "c", "d", "e", "f"];

function run(actions, ids = IDS, start = EMPTY_SELECTION) {
  return actions.reduce((state, action) => reduceRowSelection(state, action, ids), start);
}

const sorted = (state) => [...state.selected].sort();

test("idRange is inclusive in either direction", () => {
  assert.deepEqual(idRange(IDS, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(idRange(IDS, "d", "b"), ["b", "c", "d"]);
  assert.deepEqual(idRange(IDS, "b", "zz"), []);
});

test("plain click selects one row and moves the anchor", () => {
  const state = run([
    { type: "click", id: "b" },
    { type: "click", id: "e" },
  ]);
  assert.deepEqual(sorted(state), ["e"]);
  assert.equal(state.anchor, "e");
});

test("shift-click selects the range from the anchor, replacing the selection", () => {
  const state = run([
    { type: "click", id: "b" },
    { type: "click", id: "d", mods: { shift: true } },
  ]);
  assert.deepEqual(sorted(state), ["b", "c", "d"]);
  assert.equal(state.anchor, "b");
  // A second shift-click re-ranges from the same anchor.
  const shrunk = reduceRowSelection(state, { type: "click", id: "a", mods: { shift: true } }, IDS);
  assert.deepEqual(sorted(shrunk), ["a", "b"]);
});

test("ctrl-click toggles and ctrl+shift-click adds a range", () => {
  const state = run([
    { type: "click", id: "a" },
    { type: "click", id: "c", mods: { toggle: true } },
    { type: "click", id: "a", mods: { toggle: true } },
  ]);
  assert.deepEqual(sorted(state), ["c"]);
  assert.equal(state.anchor, "a");
  const added = run(
    [
      { type: "click", id: "e", mods: { toggle: true } },
      { type: "click", id: "f", mods: { shift: true, toggle: true } },
    ],
    IDS,
    state,
  );
  assert.deepEqual(sorted(added), ["c", "e", "f"]);
});

test("shift-click with no anchor behaves as a plain click", () => {
  const state = run([{ type: "click", id: "c", mods: { shift: true } }]);
  assert.deepEqual(sorted(state), ["c"]);
  assert.equal(state.anchor, "c");
});

test("checkbox toggles, and shift on a checkbox adds the range then moves the anchor", () => {
  const state = run([
    { type: "toggle", id: "a" },
    { type: "toggle", id: "c", shift: true },
  ]);
  assert.deepEqual(sorted(state), ["a", "b", "c"]);
  assert.equal(state.anchor, "c");
  const more = reduceRowSelection(state, { type: "toggle", id: "e", shift: true }, IDS);
  assert.deepEqual(sorted(more), ["a", "b", "c", "d", "e"]);
});

test("shift+arrow extends from the anchor, starting at the row focus left", () => {
  let state = run([{ type: "extend", from: "b", to: "c" }]);
  assert.deepEqual(sorted(state), ["b", "c"]);
  assert.equal(state.anchor, "b");
  state = reduceRowSelection(state, { type: "extend", from: "c", to: "d" }, IDS);
  assert.deepEqual(sorted(state), ["b", "c", "d"]);
  // Back up past the anchor: the range flips direction.
  state = run(
    [
      { type: "extend", from: "d", to: "c" },
      { type: "extend", from: "c", to: "b" },
      { type: "extend", from: "b", to: "a" },
    ],
    IDS,
    state,
  );
  assert.deepEqual(sorted(state), ["a", "b"]);
});

test("ranges span rows from a later page once it is loaded", () => {
  const firstPage = ["a", "b", "c"];
  const anchored = run([{ type: "click", id: "b" }], firstPage);
  const bothPages = [...firstPage, "d", "e", "f"];
  const state = reduceRowSelection(
    anchored,
    { type: "click", id: "e", mods: { shift: true } },
    bothPages,
  );
  assert.deepEqual(sorted(state), ["b", "c", "d", "e"]);
});

test("an anchor that is no longer listed is ignored", () => {
  const anchored = run([{ type: "click", id: "b" }]);
  const filtered = ["c", "d", "e"];
  const state = reduceRowSelection(
    anchored,
    { type: "click", id: "e", mods: { shift: true } },
    filtered,
  );
  assert.deepEqual(sorted(state), ["e"]);
  assert.equal(state.anchor, "e");
});

test("select all takes every loaded row; clear empties and drops the anchor", () => {
  const all = run([{ type: "click", id: "c" }, { type: "selectAll" }]);
  assert.equal(all.selected.size, IDS.length);
  assert.equal(all.anchor, "c");
  const cleared = reduceRowSelection(all, { type: "clear" }, IDS);
  assert.equal(cleared.selected.size, 0);
  assert.equal(cleared.anchor, null);
});
