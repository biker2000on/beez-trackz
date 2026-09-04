/**
 * Unit coverage for the runtime brand contract (roadmap P1 item 11).
 *
 * The e2e spec can only exercise the brand the dev server was started with,
 * so the multi-brand half of the matrix lives here: the same `parseBrand`
 * the server calls, driven with the GentleBee production environment, a third
 * unrelated test brand, and the invalid values that must be fatal.
 *
 * Imports the real `src/lib/brand.ts` directly — Node’s built-in TypeScript
 * type stripping means the test exercises the shipped module, not a copy of it.
 *
 * Run: node --test tests/unit/brand.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  BrandConfigError,
  DEFAULT_BACKGROUND_COLOR,
  DEFAULT_DISPLAY_NAME,
  DEFAULT_TAGLINE,
  DEFAULT_THEME_COLOR,
  PRODUCT_NAME,
  deriveShortName,
  parseBrand,
} from "../../src/lib/brand.ts";

test("unconfigured environment resolves to Apiary Atlas", () => {
  const brand = parseBrand({});
  assert.equal(brand.displayName, "Apiary Atlas");
  assert.equal(brand.shortName, "Apiary Atlas");
  assert.equal(brand.tagline, DEFAULT_TAGLINE);
  assert.equal(brand.wordmarkUrl, null);
  assert.equal(brand.markUrl, null);
  assert.equal(brand.themeColor, DEFAULT_THEME_COLOR);
  assert.equal(brand.backgroundColor, DEFAULT_BACKGROUND_COLOR);
  assert.equal(brand.product, PRODUCT_NAME);
  assert.equal(brand.displayName, DEFAULT_DISPLAY_NAME);
});

test("Gentle Bee production: display name alone rebrands the deployment", () => {
  const brand = parseBrand({ BRAND_DISPLAY_NAME: "GentleBee Atlas" });
  assert.equal(brand.displayName, "GentleBee Atlas");
  // 15 code points is too long for a launcher label, so it is cut back to the
  // last word boundary inside the 12-point window.
  assert.equal(brand.shortName, "GentleBee");
  // Per-field fallback: the untouched fields keep the Apiary Atlas defaults.
  assert.equal(brand.tagline, DEFAULT_TAGLINE);
  assert.equal(brand.themeColor, DEFAULT_THEME_COLOR);
  assert.equal(brand.backgroundColor, DEFAULT_BACKGROUND_COLOR);
  // The product name is never overwritten by a deployment brand.
  assert.equal(brand.product, "Apiary Atlas");
});

test("third brand: every field overridden, no source edit and no rebuild", () => {
  const brand = parseBrand({
    BRAND_DISPLAY_NAME: "Thistledown Bees",
    BRAND_SHORT_NAME: "Thistle",
    BRAND_TAGLINE: "Records for the Thistledown yards",
    BRAND_WORDMARK_URL: "/brand/thistledown-wordmark.svg",
    BRAND_MARK_URL: "https://cdn.example.test/thistle-mark.png",
    BRAND_THEME_COLOR: "#4B0082",
    BRAND_BACKGROUND_COLOR: "#FFFFFF",
  });
  assert.deepEqual(brand, {
    displayName: "Thistledown Bees",
    shortName: "Thistle",
    tagline: "Records for the Thistledown yards",
    wordmarkUrl: "/brand/thistledown-wordmark.svg",
    markUrl: "https://cdn.example.test/thistle-mark.png",
    // Colors are normalised to lower case so both sides of the seam emit the
    // same string.
    themeColor: "#4b0082",
    backgroundColor: "#ffffff",
    product: "Apiary Atlas",
  });
});

test("unset, empty, and whitespace-only are the same thing", () => {
  const base = parseBrand({});
  for (const value of ["", "   ", "\t\n"]) {
    const brand = parseBrand({
      BRAND_DISPLAY_NAME: value,
      BRAND_SHORT_NAME: value,
      BRAND_TAGLINE: value,
      BRAND_WORDMARK_URL: value,
      BRAND_MARK_URL: value,
      BRAND_THEME_COLOR: value,
      BRAND_BACKGROUND_COLOR: value,
    });
    assert.deepEqual(brand, base, `reset-to-default failed for ${JSON.stringify(value)}`);
  }
});

test("values are trimmed before validation", () => {
  const brand = parseBrand({
    BRAND_DISPLAY_NAME: "  Hollow Log Apiary  ",
    BRAND_THEME_COLOR: " #123abc ",
  });
  assert.equal(brand.displayName, "Hollow Log Apiary");
  assert.equal(brand.themeColor, "#123abc");
});

test("short-name derivation", () => {
  // Fits exactly: kept whole.
  assert.equal(deriveShortName("Apiary Atlas"), "Apiary Atlas");
  assert.equal(deriveShortName("Bees"), "Bees");
  // Too long with a space inside the window: cut at the last space.
  assert.equal(deriveShortName("GentleBee Atlas"), "GentleBee");
  assert.equal(deriveShortName("Sunny Meadow Apiary"), "Sunny Meadow");
  // Too long with no space inside the window: hard cut, no ellipsis.
  assert.equal(deriveShortName("Thistledownbeekeeping"), "Thistledownb");
  // Length is code points, not UTF-16 units: 12 emoji are 24 units but fit.
  assert.equal(deriveShortName("🐝".repeat(12)), "🐝".repeat(12));
});

function rejects(env, variable) {
  assert.throws(
    () => parseBrand(env),
    (error) => {
      assert.ok(
        error instanceof BrandConfigError,
        `expected BrandConfigError, got ${error?.name}`,
      );
      assert.match(error.message, new RegExp(variable));
      return true;
    },
    `expected ${JSON.stringify(env)} to be rejected`,
  );
}

test("over-long text is fatal, never truncated and never defaulted", () => {
  rejects({ BRAND_DISPLAY_NAME: "a".repeat(41) }, "BRAND_DISPLAY_NAME");
  rejects({ BRAND_SHORT_NAME: "a".repeat(13) }, "BRAND_SHORT_NAME");
  rejects({ BRAND_TAGLINE: "a".repeat(121) }, "BRAND_TAGLINE");
  // The boundary itself is allowed.
  assert.equal(parseBrand({ BRAND_DISPLAY_NAME: "a".repeat(40) }).displayName, "a".repeat(40));
  assert.equal(parseBrand({ BRAND_SHORT_NAME: "a".repeat(12) }).shortName, "a".repeat(12));
  assert.equal(parseBrand({ BRAND_TAGLINE: "a".repeat(120) }).tagline, "a".repeat(120));
  // Code points, not UTF-16 units: 40 emoji are 80 units and still valid.
  assert.equal(parseBrand({ BRAND_DISPLAY_NAME: "🐝".repeat(40) }).displayName, "🐝".repeat(40));
  rejects({ BRAND_DISPLAY_NAME: "🐝".repeat(41) }, "BRAND_DISPLAY_NAME");
});

test("brand text cannot smuggle in markup or control characters", () => {
  rejects({ BRAND_DISPLAY_NAME: "<script>alert(1)</script>" }, "BRAND_DISPLAY_NAME");
  rejects({ BRAND_DISPLAY_NAME: "Bees <b>" }, "BRAND_DISPLAY_NAME");
  rejects({ BRAND_TAGLINE: "Line one\u0000line two" }, "BRAND_TAGLINE");
  rejects({ BRAND_SHORT_NAME: "Bee\u0007s" }, "BRAND_SHORT_NAME");
});

test("asset URLs: only /brand/ paths and https", () => {
  for (const url of [
    "/brand/mark.svg",
    "/brand/nested/mark-2x.png",
    "https://cdn.example.test/mark.svg",
    "https://cdn.example.test/mark.svg?v=2",
  ]) {
    assert.equal(parseBrand({ BRAND_MARK_URL: url }).markUrl, url);
  }
});

test("asset URLs: everything else is fatal", () => {
  for (const url of [
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "http://cdn.example.test/mark.svg",
    "//cdn.example.test/mark.svg",
    "/icons/icon-192.png",
    "/brand/",
    "/brand/../../etc/passwd",
    "brand/mark.svg",
    "https://user:pass@cdn.example.test/mark.svg",
    "/brand/mark .svg",
    "C:\brand\mark.svg",
    "vbscript:msgbox(1)",
  ]) {
    rejects({ BRAND_MARK_URL: url }, "BRAND_MARK_URL");
    rejects({ BRAND_WORDMARK_URL: url }, "BRAND_WORDMARK_URL");
  }
});

test("colors: only #rrggbb", () => {
  for (const color of ["#fff", "#ffffffff", "rebeccapurple", "rgb(1,2,3)", "#12345g", "ffffff"]) {
    rejects({ BRAND_THEME_COLOR: color }, "BRAND_THEME_COLOR");
    rejects({ BRAND_BACKGROUND_COLOR: color }, "BRAND_BACKGROUND_COLOR");
  }
});

test("one bad field fails the whole resolution — no partial brand", () => {
  rejects(
    { BRAND_DISPLAY_NAME: "GentleBee Atlas", BRAND_THEME_COLOR: "not-a-color" },
    "BRAND_THEME_COLOR",
  );
});
