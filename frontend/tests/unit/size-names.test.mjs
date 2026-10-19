/**
 * Market day's short size names (`features/commerce/size-names.ts`): the
 * catalog's words shortened one for one, anything else passed through.
 *
 * Run: node --test tests/unit/size-names.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import { shortSizeName } from "../../src/features/commerce/size-names.ts";

test("catalog words shorten and the rest of the label is kept", () => {
  assert.equal(shortSizeName("Quart"), "Qt");
  assert.equal(shortSizeName("Pint"), "Pt");
  assert.equal(shortSizeName("Half pint"), "½ pt");
  assert.equal(shortSizeName("Half-gallon"), "½ gal");
  assert.equal(shortSizeName("8 ounce"), "8 oz");
  assert.equal(shortSizeName("1 pound"), "1 lb");
});

test("a label with no catalog word is untouched", () => {
  assert.equal(shortSizeName("12 oz Bear"), "12 oz Bear");
  assert.equal(shortSizeName("1 lb Queenline"), "1 lb Queenline");
  assert.equal(shortSizeName("  9 oz "), "9 oz");
});
