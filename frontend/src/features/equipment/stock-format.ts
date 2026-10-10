/**
 * Stock quantities arrive from the ledger as fixed-point strings
 * ("2.0000", "12.5000") in the item's canonical unit ("count" for jars,
 * equipment, packaging and products; "lb" for bulk honey). These helpers turn
 * them into what a person reads: "2", "12.5 lb".
 */

/** Parses a ledger quantity; empty or malformed becomes null. */
export function parseStockQuantity(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Units that are a plain tally and read best without a suffix. */
const COUNT_UNITS = new Set(["count", "each", "ea", "unit", "units", "pcs", ""]);

/**
 * "2.0000" + "count" -> "2"; "12.5000" + "lb" -> "12.5 lb"; fractional counts
 * keep up to two decimals. Pass `signed` for movements ("+3", "−1.5 lb").
 */
export function formatStockQuantity(
  value: string | number | null | undefined,
  unit: string | null | undefined,
  options: { signed?: boolean } = {},
): string {
  const n = parseStockQuantity(value);
  if (n == null) return "—";
  const normalizedUnit = (unit ?? "").trim().toLowerCase();
  const isCount = COUNT_UNITS.has(normalizedUnit);
  const digits = isCount && Number.isInteger(n) ? 0 : 2;
  const magnitude = Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
  const sign = n < 0 ? "−" : options.signed && n > 0 ? "+" : "";
  const suffix = isCount ? "" : ` ${unit!.trim()}`;
  return `${sign}${magnitude}${suffix}`;
}

