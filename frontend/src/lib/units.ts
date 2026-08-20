/**
 * Display conversion for operator unit preference.
 *
 * API responses stay canonical. This module formats for the screen and parses
 * typed suffixes ("2 kg", "4.4 lb") back to the stored unit.
 *
 * Canonical storage (do not migrate existing columns to new units):
 *   honey mass / lot weight  → pounds
 *   propolis                 → grams (amount_grams; amount+unit still written)
 *   elevation                → meters
 *   weather temperature      → Fahrenheit (Open-Meteo request today)
 *   weather wind             → miles per hour
 *   feedings                 → quantity + quantity_unit as stored
 */

export type UnitsSystem = "metric" | "us";
export type TemperatureUnit = "c" | "f";

export const GRAMS_PER_POUND = 453.59237;
export const GRAMS_PER_OUNCE = 28.349523125;
export const OUNCES_PER_POUND = 16;
export const METERS_PER_FOOT = 0.3048;
export const KM_PER_MILE = 1.609344;
export const LITERS_PER_QUART = 0.946352946;
export const LITERS_PER_GALLON = 3.785411784;

const US_CUSTOMARY_REGIONS = new Set(["US", "LR", "MM"]);

/** Browser-locale default. US / Liberia / Myanmar → us; everyone else metric. */
export function detectLocaleUnits(
  locale = typeof navigator !== "undefined" ? navigator.language : "en-US",
): UnitsSystem {
  try {
    const region = new Intl.Locale(locale).maximize().region;
    if (region && US_CUSTOMARY_REGIONS.has(region)) return "us";
  } catch {
    if (locale === "en-US" || locale.startsWith("en-US")) return "us";
  }
  return "metric";
}

export function temperatureUnitFor(
  units: UnitsSystem,
  override?: TemperatureUnit | null,
): TemperatureUnit {
  if (override === "c" || override === "f") return override;
  return units === "metric" ? "c" : "f";
}

function trimNumber(value: number, digits: number): string {
  if (!Number.isFinite(value)) return "";
  const fixed = value.toFixed(digits);
  return fixed.replace(/\.?0+$/, "");
}

export type FormattedQuantity = {
  value: number;
  unit: string;
  text: string;
  /** Dual label when a print/legal slot exists, e.g. "1 lb (454 g)". */
  dual: string;
};

function qty(value: number, unit: string, other: string): FormattedQuantity {
  const text = `${trimNumber(value, 2)} ${unit}`;
  return { value, unit, text, dual: `${text} (${other})` };
}

/** Honey / lot weight. Canonical: pounds. */
export function formatHoneyMass(
  pounds: number | null | undefined,
  units: UnitsSystem,
): FormattedQuantity | null {
  if (pounds == null || !Number.isFinite(pounds)) return null;
  const grams = pounds * GRAMS_PER_POUND;
  if (units === "metric") {
    if (Math.abs(grams) >= 1000) {
      const kg = grams / 1000;
      return qty(kg, "kg", `${trimNumber(pounds, 2)} lb`);
    }
    return qty(grams, "g", `${trimNumber(pounds, 2)} lb`);
  }
  if (Math.abs(pounds) > 0 && Math.abs(pounds) < 1) {
    const oz = pounds * OUNCES_PER_POUND;
    return qty(oz, "oz", `${trimNumber(grams, 0)} g`);
  }
  return qty(pounds, "lb", `${trimNumber(grams, 0)} g`);
}

/** Propolis. Canonical: grams. */
export function formatPropolisMass(
  grams: number | null | undefined,
  units: UnitsSystem,
): FormattedQuantity | null {
  if (grams == null || !Number.isFinite(grams)) return null;
  if (units === "us") {
    const oz = grams / GRAMS_PER_OUNCE;
    return qty(oz, "oz", `${trimNumber(grams, 1)} g`);
  }
  if (Math.abs(grams) >= 1000) {
    return qty(grams / 1000, "kg", `${trimNumber(grams / GRAMS_PER_OUNCE, 2)} oz`);
  }
  return qty(grams, "g", `${trimNumber(grams / GRAMS_PER_OUNCE, 2)} oz`);
}

/** Elevation. Canonical: meters. */
export function formatElevation(
  meters: number | null | undefined,
  units: UnitsSystem,
): FormattedQuantity | null {
  if (meters == null || !Number.isFinite(meters)) return null;
  if (units === "us") {
    const feet = meters / METERS_PER_FOOT;
    return qty(Math.round(feet * 10) / 10, "ft", `${trimNumber(meters, 1)} m`);
  }
  return qty(Math.round(meters * 10) / 10, "m", `${trimNumber(meters / METERS_PER_FOOT, 0)} ft`);
}

/** Weather temperature. Canonical: Fahrenheit (current Open-Meteo request). */
export function formatTemperatureF(
  fahrenheit: number | null | undefined,
  temp: TemperatureUnit,
): FormattedQuantity | null {
  if (fahrenheit == null || !Number.isFinite(fahrenheit)) return null;
  if (temp === "c") {
    const celsius = ((fahrenheit - 32) * 5) / 9;
    return qty(Math.round(celsius), "°C", `${Math.round(fahrenheit)}°F`);
  }
  return qty(Math.round(fahrenheit), "°F", `${Math.round(((fahrenheit - 32) * 5) / 9)}°C`);
}

/** Weather wind. Canonical: mph. */
export function formatWindMph(
  mph: number | null | undefined,
  units: UnitsSystem,
): FormattedQuantity | null {
  if (mph == null || !Number.isFinite(mph)) return null;
  if (units === "metric") {
    const kmh = mph * KM_PER_MILE;
    return qty(Math.round(kmh), "km/h", `${Math.round(mph)} mph`);
  }
  return qty(Math.round(mph), "mph", `${Math.round(mph * KM_PER_MILE)} km/h`);
}

export type FeedingUnit = "lbs" | "oz" | "quarts" | "gallons";

/** Feedings: convert the stored quantity+unit into the preferred system. */
export function formatFeeding(
  quantity: number | null | undefined,
  unit: string | null | undefined,
  units: UnitsSystem,
): FormattedQuantity | null {
  if (quantity == null || !Number.isFinite(quantity) || !unit) return null;
  const stored = unit.toLowerCase() as FeedingUnit | string;
  if (stored === "lbs" || stored === "lb") {
    return formatHoneyMass(quantity, units);
  }
  if (stored === "oz") {
    return formatHoneyMass(quantity / OUNCES_PER_POUND, units);
  }
  if (stored === "quarts" || stored === "quart") {
    const liters = quantity * LITERS_PER_QUART;
    if (units === "metric") {
      if (Math.abs(liters) >= 1) {
        return qty(liters, "L", `${trimNumber(quantity, 2)} qt`);
      }
      return qty(liters * 1000, "ml", `${trimNumber(quantity, 2)} qt`);
    }
    return qty(quantity, "qt", `${trimNumber(liters, 2)} L`);
  }
  if (stored === "gallons" || stored === "gallon") {
    if (units === "metric") {
      return qty(quantity * LITERS_PER_GALLON, "L", `${trimNumber(quantity, 2)} gal`);
    }
    return qty(quantity, "gal", `${trimNumber(quantity * LITERS_PER_GALLON, 2)} L`);
  }
  return qty(quantity, unit, trimNumber(quantity, 2));
}

export type ParsedMass = {
  grams: number;
  pounds: number;
  suffix: string | null;
};

const MASS_SUFFIX: Record<string, (n: number) => ParsedMass> = {
  kg: (n) => ({ grams: n * 1000, pounds: (n * 1000) / GRAMS_PER_POUND, suffix: "kg" }),
  g: (n) => ({ grams: n, pounds: n / GRAMS_PER_POUND, suffix: "g" }),
  gram: (n) => MASS_SUFFIX.g(n),
  grams: (n) => MASS_SUFFIX.g(n),
  lb: (n) => ({ grams: n * GRAMS_PER_POUND, pounds: n, suffix: "lb" }),
  lbs: (n) => MASS_SUFFIX.lb(n),
  pound: (n) => MASS_SUFFIX.lb(n),
  pounds: (n) => MASS_SUFFIX.lb(n),
  oz: (n) => ({
    grams: n * GRAMS_PER_OUNCE,
    pounds: n / OUNCES_PER_POUND,
    suffix: "oz",
  }),
  ounce: (n) => MASS_SUFFIX.oz(n),
  ounces: (n) => MASS_SUFFIX.oz(n),
};

const MASS_PATTERN =
  /^([+-]?(?:\d+\.?\d*|\.\d+))\s*(kg|g|grams?|lbs?|pounds?|oz|ounces?)?$/i;

/**
 * Parse a typed mass ("2 kg", "4.4 lb", "500g", "12"). Bare numbers use
 * `fallback`: the preferred display unit's canonical counterpart.
 */
export function parseMass(
  raw: string,
  fallback: "grams" | "pounds" = "pounds",
): ParsedMass | null {
  const text = raw.trim();
  if (!text) return null;
  const match = MASS_PATTERN.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const suffix = match[2]?.toLowerCase();
  if (suffix && MASS_SUFFIX[suffix]) return MASS_SUFFIX[suffix](value);
  if (fallback === "grams") {
    return { grams: value, pounds: value / GRAMS_PER_POUND, suffix: null };
  }
  return { grams: value * GRAMS_PER_POUND, pounds: value, suffix: null };
}

export type ParsedQuantity = {
  quantity: number;
  unit: FeedingUnit;
};

const VOLUME_SUFFIX: Record<string, (n: number) => ParsedQuantity> = {
  l: (n) => ({ quantity: n / LITERS_PER_QUART, unit: "quarts" }),
  liter: (n) => VOLUME_SUFFIX.l(n),
  liters: (n) => VOLUME_SUFFIX.l(n),
  ml: (n) => VOLUME_SUFFIX.l(n / 1000),
  qt: (n) => ({ quantity: n, unit: "quarts" }),
  qts: (n) => VOLUME_SUFFIX.qt(n),
  quart: (n) => VOLUME_SUFFIX.qt(n),
  quarts: (n) => VOLUME_SUFFIX.qt(n),
  gal: (n) => ({ quantity: n, unit: "gallons" }),
  gallon: (n) => VOLUME_SUFFIX.gal(n),
  gallons: (n) => VOLUME_SUFFIX.gal(n),
};

const QUANTITY_PATTERN =
  /^([+-]?(?:\d+\.?\d*|\.\d+))\s*(kg|g|grams?|lbs?|pounds?|oz|ounces?|l|liters?|ml|qts?|quarts?|gal|gallons?)?$/i;

/**
 * Parse a feeding/input quantity with optional suffix. Mass suffixes convert
 * to lbs (the feeding enum); volume suffixes convert to quarts/gallons.
 */
export function parseFeedingQuantity(
  raw: string,
  preferred: UnitsSystem,
): ParsedQuantity | null {
  const text = raw.trim();
  if (!text) return null;
  const match = QUANTITY_PATTERN.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const suffix = match[2]?.toLowerCase();
  if (suffix && MASS_SUFFIX[suffix]) {
    return { quantity: MASS_SUFFIX[suffix](value).pounds, unit: "lbs" };
  }
  if (suffix && VOLUME_SUFFIX[suffix]) return VOLUME_SUFFIX[suffix](value);
  if (preferred === "metric") {
    return { quantity: value, unit: "lbs" };
  }
  return { quantity: value, unit: "lbs" };
}

export type UnitsPreference = {
  units: UnitsSystem;
  temperature: TemperatureUnit;
};

export function resolveUnitsPreference(input: {
  units?: string | null;
  temperatureUnit?: string | null;
  locale?: string;
}): UnitsPreference {
  const units: UnitsSystem =
    input.units === "metric" || input.units === "us"
      ? input.units
      : detectLocaleUnits(input.locale);
  const temperature = temperatureUnitFor(
    units,
    input.temperatureUnit === "c" || input.temperatureUnit === "f"
      ? input.temperatureUnit
      : null,
  );
  return { units, temperature };
}

/** Preferred mass input suffix shown on forms. */
export function preferredMassSuffix(units: UnitsSystem, kind: "honey" | "propolis"): string {
  if (kind === "propolis") return units === "us" ? "oz" : "g";
  return units === "metric" ? "kg" : "lb";
}
