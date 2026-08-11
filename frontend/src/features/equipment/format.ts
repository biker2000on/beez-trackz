/** Formatting helpers shared across the equipment feature. */

/** Today's date in local time as a YYYY-MM-DD string (for date inputs). */
export function todayISO(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Friendly display for an API date (RFC3339 or YYYY-MM-DD): "Jul 23, 2026".
 * Only the date part is shown.
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

/** Money arrives from the API as integer cents; render it as currency. */
export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

/**
 * Parse a currency input ("12.50") into integer cents; empty becomes null.
 *
 * A comma followed by exactly 1–2 trailing digits is a decimal separator —
 * comma-decimal mobile keyboards only offer the comma key, and stripping it
 * turned "24,50" into $2,450. Other commas are thousands grouping.
 */
export function parseCents(value: string): number | null {
  let trimmed = value.trim().replace(/\$/g, "");
  const decimalComma = /^(\d{1,3}(?:\.\d{3})*|\d+),(\d{1,2})$/.exec(trimmed);
  if (decimalComma) {
    trimmed = `${decimalComma[1].replace(/\./g, "")}.${decimalComma[2]}`;
  } else {
    trimmed = trimmed.replace(/,/g, "");
  }
  if (trimmed === "") return null;
  const amount = Number(trimmed);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

/** Parse a numeric input string; empty or invalid becomes null. */
export function parseNum(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
