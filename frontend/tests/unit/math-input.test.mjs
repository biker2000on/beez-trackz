import test from "node:test";
import assert from "node:assert/strict";
import { evaluateNumericInput } from "../../src/lib/math-input.ts";

test("sums, products and precedence", () => {
  assert.equal(evaluateNumericInput("12+12+12"), "36");
  assert.equal(evaluateNumericInput("3*12"), "36");
  assert.equal(evaluateNumericInput("3x12"), "36");
  assert.equal(evaluateNumericInput("2+3*4"), "14");
  assert.equal(evaluateNumericInput("(2+3)*4"), "20");
  assert.equal(evaluateNumericInput("10/4"), "2.5");
  assert.equal(evaluateNumericInput("-3*2"), "-6");
});
test("plain numbers and empties are untouched", () => {
  assert.equal(evaluateNumericInput("12"), null);
  assert.equal(evaluateNumericInput("-12.5"), null);
  assert.equal(evaluateNumericInput(""), null);
  assert.equal(evaluateNumericInput("  "), null);
});
test("units survive", () => {
  assert.equal(evaluateNumericInput("3*12 lb"), "36 lb");
  assert.equal(evaluateNumericInput("2*454g"), "908 g");
  assert.equal(evaluateNumericInput("20 lb"), null);
});
test("garbage and division by zero are left alone", () => {
  assert.equal(evaluateNumericInput("3*"), null);
  assert.equal(evaluateNumericInput("abc"), null);
  assert.equal(evaluateNumericInput("1/0"), null);
  assert.equal(evaluateNumericInput("alert(1)"), null);
});
