/**
 * Runtime brand contract — server-authoritative half.
 *
 * ---------------------------------------------------------------------------
 * SHARED BRAND CONTRACT (roadmap P1 item 11)
 *
 * The Go API and this Next.js app read the SAME environment variables and must
 * apply the SAME validation and the SAME per-field fallback, so a deployment
 * cannot be called one thing by a notification and another thing by the tab
 * title. Keep this comment block byte-comparable with the Go brand package;
 * if a rule changes, change it in both places in the same commit.
 *
 *   Variable                 Required  Rule
 *   -----------------------  --------  --------------------------------------
 *   BRAND_DISPLAY_NAME       no        1–40 code points after trim.
 *                                      Default: "Apiary Atlas".
 *   BRAND_SHORT_NAME         no        1–12 code points after trim.
 *                                      Default: derived from the display name
 *                                      (see "short-name derivation" below).
 *   BRAND_TAGLINE            no        1–120 code points after trim.
 *                                      Default: "Hive, harvest and honey
 *                                      records for a working apiary".
 *   BRAND_WORDMARK_URL       no        Asset URL (see "asset URLs"). Unset =>
 *                                      the built-in Apiary Atlas wordmark
 *                                      (the brand name set in type).
 *   BRAND_MARK_URL           no        Asset URL. Unset => the built-in
 *                                      Apiary Atlas honeycomb mark.
 *   BRAND_THEME_COLOR        no        "#rrggbb". Default: "#d97706".
 *   BRAND_BACKGROUND_COLOR   no        "#rrggbb". Default: "#fbf7ef".
 *
 * Product identity. `Brand.product` is the constant "Apiary Atlas". It is the
 * upstream product name and is NOT configurable; it exists so provenance
 * records (snapshot metadata, support copy) can say which product produced a
 * file even when the deployment brand differs. It never renames anything.
 *
 * Empty / whitespace-only. An unset variable and a variable set to only
 * whitespace are the same thing: fall back to the default for THAT FIELD ONLY.
 * Fallback is always per-field — setting BRAND_DISPLAY_NAME does not clear the
 * default tagline or the default colors.
 *
 * Text rules (display name, short name, tagline). After trimming:
 *   - length is counted in Unicode code points, not UTF-16 units;
 *   - C0/C1 control characters (including newlines and tabs) are rejected;
 *   - "<" and ">" are rejected. Brand text is always rendered as text, never
 *     as markup, so this is defence in depth rather than the only guard.
 * A value that is present but breaks a rule is FATAL — it is never silently
 * repaired and never silently replaced with the default. A typo in the
 * deployment environment must stop the process, not quietly ship the wrong
 * name.
 *
 * Short-name derivation. When BRAND_SHORT_NAME is unset:
 *   - display name of at most 12 code points  -> used whole;
 *   - otherwise take the first 12 code points as the window, then:
 *       - if code point 12 (the next one) is a space, the window already ends
 *         on a word boundary: use it as-is, trailing space trimmed;
 *       - else if the window contains a space at index > 0, cut at the last
 *         one;
 *       - else use the window unchanged (hard cut).
 *   No ellipsis is ever added.
 * Worked examples: "Apiary Atlas" (12) -> "Apiary Atlas"; "GentleBee Atlas"
 * -> "GentleBee"; "Sunny Meadow Apiary" -> "Sunny Meadow";
 * "Thistledownbeekeeping" -> "Thistledownb".
 * An explicitly configured BRAND_SHORT_NAME longer than 12 code points is
 * fatal — deriving is a convenience, overriding is a promise.
 *
 * Asset URLs (wordmark, mark). Exactly two shapes are accepted:
 *   1. a same-origin absolute path under "/brand/" — must start with "/brand/",
 *      must have at least one character after it, and must not contain "..",
 *      a backslash, whitespace, or a control character; and
 *   2. an absolute "https://" URL that parses, has no userinfo, and contains
 *      no whitespace or control characters.
 * Everything else is fatal, explicitly including "data:", "javascript:",
 * plain "http://", and protocol-relative "//host/x". Configuration may point
 * at a picture; it may never smuggle in executable or inline content.
 *
 * Colors. Exactly "#rrggbb" (case-insensitive, normalised to lower case).
 * Three-digit shorthand, named colors, and "#rrggbbaa" are fatal. Brand colors
 * tint only the browser theme color and the manifest/app background. They are
 * never applied to body text or to a text/background pair, so a low-contrast
 * brand color cannot make the app unreadable in either light or dark mode.
 * The dark-mode browser theme color is a fixed app constant for the same
 * reason (see DARK_THEME_COLOR).
 * ---------------------------------------------------------------------------
 */

/** The upstream product name. Constant — never read from configuration. */
export const PRODUCT_NAME = "Apiary Atlas" as const;

export const DEFAULT_DISPLAY_NAME = PRODUCT_NAME;
export const DEFAULT_TAGLINE =
  "Hive, harvest and honey records for a working apiary";
export const DEFAULT_THEME_COLOR = "#d97706";
export const DEFAULT_BACKGROUND_COLOR = "#fbf7ef";

/**
 * Browser theme color in dark mode. Not configurable: it pairs with the app's
 * dark surface tokens, and letting a deployment tint it is how you end up with
 * an unreadable status bar. BRAND_THEME_COLOR applies to light mode only.
 */
export const DARK_THEME_COLOR = "#1c1917";

export const DISPLAY_NAME_MAX = 40;
export const SHORT_NAME_MAX = 12;
export const TAGLINE_MAX = 120;

/** The resolved, public presentation brand. Safe to serialize to the browser. */
export type Brand = {
  /** Deployment display name, e.g. "GentleBee Atlas". */
  displayName: string;
  /** Compact name for launchers and tight chrome, e.g. "GentleBee". */
  shortName: string;
  /** One-line description used for metadata and the manifest. */
  tagline: string;
  /** Validated wordmark image URL, or null for the built-in wordmark. */
  wordmarkUrl: string | null;
  /** Validated mark/icon image URL, or null for the built-in mark. */
  markUrl: string | null;
  /** Light-mode theme color, "#rrggbb". */
  themeColor: string;
  /** Manifest/app background color, "#rrggbb". */
  backgroundColor: string;
  /** The upstream product name. Always "Apiary Atlas". */
  product: typeof PRODUCT_NAME;
};

/** Thrown when a configured brand value is present but invalid. */
export class BrandConfigError extends Error {
  constructor(variable: string, reason: string) {
    super(`invalid brand configuration: ${variable} ${reason}`);
    this.name = "BrandConfigError";
  }
}

/** The subset of the environment the brand contract reads. */
export type BrandEnv = {
  BRAND_DISPLAY_NAME?: string;
  BRAND_SHORT_NAME?: string;
  BRAND_TAGLINE?: string;
  BRAND_WORDMARK_URL?: string;
  BRAND_MARK_URL?: string;
  BRAND_THEME_COLOR?: string;
  BRAND_BACKGROUND_COLOR?: string;
};

/** Unset and whitespace-only mean the same thing: use the field's default. */
function present(raw: string | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

// C0 (U+0000–U+001F), DEL (U+007F), and C1 (U+0080–U+009F).
function hasControlChar(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function parseText(
  variable: string,
  raw: string | null,
  max: number,
): string | null {
  if (raw === null) return null;
  if (hasControlChar(raw)) {
    throw new BrandConfigError(variable, "must not contain control characters");
  }
  if (raw.includes("<") || raw.includes(">")) {
    throw new BrandConfigError(variable, 'must not contain "<" or ">"');
  }
  const length = codePointLength(raw);
  if (length < 1 || length > max) {
    throw new BrandConfigError(
      variable,
      `must be 1–${max} characters (got ${length})`,
    );
  }
  return raw;
}

/** See "short-name derivation" in the contract block above. */
export function deriveShortName(displayName: string): string {
  const points = Array.from(displayName);
  if (points.length <= SHORT_NAME_MAX) return displayName;
  const window = points.slice(0, SHORT_NAME_MAX).join("");
  // The window already ends on a word boundary ("Sunny Meadow| Apiary"), so
  // there is nothing to cut back to — taking the last space would throw away
  // a whole word for no reason.
  if (points[SHORT_NAME_MAX] === " ") return window.trimEnd();
  const lastSpace = window.lastIndexOf(" ");
  const cut = lastSpace > 0 ? window.slice(0, lastSpace) : window;
  return cut.trim() || window.trim();
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function parseColor(variable: string, raw: string | null): string | null {
  if (raw === null) return null;
  if (!HEX_COLOR.test(raw)) {
    throw new BrandConfigError(variable, 'must be a "#rrggbb" hex color');
  }
  return raw.toLowerCase();
}

function parseAssetUrl(variable: string, raw: string | null): string | null {
  if (raw === null) return null;
  if (hasControlChar(raw) || /\s/.test(raw)) {
    throw new BrandConfigError(
      variable,
      "must not contain whitespace or control characters",
    );
  }
  if (raw.includes("\\")) {
    throw new BrandConfigError(variable, "must not contain a backslash");
  }

  if (raw.startsWith("/")) {
    // "//host/x" is protocol-relative, not same-origin. Reject before the
    // "/brand/" check so it cannot be smuggled in as "//brand/..." style input.
    if (raw.startsWith("//")) {
      throw new BrandConfigError(
        variable,
        "must not be a protocol-relative URL",
      );
    }
    if (!raw.startsWith("/brand/") || raw.length <= "/brand/".length) {
      throw new BrandConfigError(
        variable,
        'must be an absolute path under "/brand/"',
      );
    }
    if (raw.includes("..")) {
      throw new BrandConfigError(variable, 'must not contain ".."');
    }
    return raw;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BrandConfigError(
      variable,
      'must be an absolute path under "/brand/" or an https:// URL',
    );
  }
  if (parsed.protocol !== "https:") {
    throw new BrandConfigError(
      variable,
      `must use https (got "${parsed.protocol}")`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new BrandConfigError(variable, "must not embed credentials");
  }
  return raw;
}

/**
 * Resolve the brand from an environment map. Pure: no process, no I/O, no
 * caching — this is the function the unit tests drive with fixture brands.
 * Throws {@link BrandConfigError} on any value that is present but invalid.
 */
export function parseBrand(env: BrandEnv): Brand {
  const displayName =
    parseText("BRAND_DISPLAY_NAME", present(env.BRAND_DISPLAY_NAME), DISPLAY_NAME_MAX) ??
    DEFAULT_DISPLAY_NAME;

  const shortName =
    parseText("BRAND_SHORT_NAME", present(env.BRAND_SHORT_NAME), SHORT_NAME_MAX) ??
    deriveShortName(displayName);

  const tagline =
    parseText("BRAND_TAGLINE", present(env.BRAND_TAGLINE), TAGLINE_MAX) ??
    DEFAULT_TAGLINE;

  return {
    displayName,
    shortName,
    tagline,
    wordmarkUrl: parseAssetUrl("BRAND_WORDMARK_URL", present(env.BRAND_WORDMARK_URL)),
    markUrl: parseAssetUrl("BRAND_MARK_URL", present(env.BRAND_MARK_URL)),
    themeColor:
      parseColor("BRAND_THEME_COLOR", present(env.BRAND_THEME_COLOR)) ??
      DEFAULT_THEME_COLOR,
    backgroundColor:
      parseColor("BRAND_BACKGROUND_COLOR", present(env.BRAND_BACKGROUND_COLOR)) ??
      DEFAULT_BACKGROUND_COLOR,
    product: PRODUCT_NAME,
  };
}

let resolved: Brand | null = null;

/**
 * The resolved brand for this server process.
 *
 * Server-only. It is computed once from `process.env` and memoised, so every
 * server component, `generateMetadata`, and the manifest see one identical
 * object; the root layout serializes that same object to the client through
 * `BrandProvider`, so SSR and hydration cannot disagree about the name.
 *
 * A bad value throws on the first call — which, because the root layout
 * resolves the brand, means the very first request fails loudly with the
 * offending variable named, rather than the app booting under the wrong brand.
 */
export function resolveBrand(): Brand {
  if (resolved === null) {
    resolved = parseBrand(process.env as BrandEnv);
  }
  return resolved;
}
