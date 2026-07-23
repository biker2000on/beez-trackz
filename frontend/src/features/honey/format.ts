/** Formatting helpers shared across the honey feature. */

/** Today's date in local time as a YYYY-MM-DD string (for date inputs). */
export function todayISO(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Friendly display for an API date (RFC3339 or YYYY-MM-DD): "Jul 23, 2026".
 * Dates are stored as calendar days, so only the date part is used.
 */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatLbs(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} lbs`;
}

export function formatMoney(value: number): string {
  return value.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

/** Parse a numeric input string; empty or invalid becomes null. */
export function parseNum(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
