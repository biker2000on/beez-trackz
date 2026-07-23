/**
 * Shared hive-domain constants and formatting helpers, used across the
 * dashboard, apiaries, and hives features.
 */

export const HIVE_STATUSES = ["active", "dead", "sold", "combined"] as const;
export type HiveStatus = (typeof HIVE_STATUSES)[number];

export const HIVE_STATUS_LABELS: Record<HiveStatus, string> = {
  active: "Active",
  dead: "Dead",
  sold: "Sold",
  combined: "Combined",
};

/** Badge classes per hive status (amber/forest palette friendly). */
export const HIVE_STATUS_BADGE: Record<HiveStatus, string> = {
  active:
    "border-transparent bg-accent-muted text-accent dark:bg-accent dark:text-accent-foreground",
  dead: "border-transparent bg-destructive/15 text-destructive",
  sold: "border-transparent bg-secondary text-secondary-foreground",
  combined: "border-transparent bg-primary/15 text-primary",
};

export const PLACEMENTS = ["full", "top", "bottom", "left", "right"] as const;

export const PLACEMENT_LABELS: Record<(typeof PLACEMENTS)[number], string> = {
  full: "Full hive",
  top: "Top (stacked nuc)",
  bottom: "Bottom (stacked nuc)",
  left: "Left (side-by-side nuc)",
  right: "Right (side-by-side nuc)",
};

/**
 * International queen-marking colors by year.
 * year % 5: 0 → blue, 1 → white, 2 → yellow, 3 → red, 4 → green.
 */
export function queenYearColor(year: number): {
  name: string;
  className: string;
} {
  switch (((year % 5) + 5) % 5) {
    case 0:
      return { name: "Blue", className: "bg-blue-500" };
    case 1:
      return { name: "White", className: "bg-white border border-border" };
    case 2:
      return { name: "Yellow", className: "bg-yellow-400" };
    case 3:
      return { name: "Red", className: "bg-red-500" };
    default:
      return { name: "Green", className: "bg-green-600" };
  }
}

/** Friendly date display, e.g. "Jul 23, 2026". Accepts RFC3339 or YYYY-MM-DD. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = parseApiDate(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Parse an API date as a calendar date. Date-only fields are stored at
 * midnight in the API server's timezone and serialized as RFC3339 with the
 * server's offset, so converting them through the browser's timezone can
 * shift them a day (e.g. UTC server, US browser). The leading YYYY-MM-DD of
 * the string IS the server-local calendar date — use it directly.
 */
export function parseApiDate(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    const [y, m, d] = value.slice(0, 10).split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(value);
}

/** Whole days elapsed since the given date (0 for today). */
export function daysSince(value: string): number {
  const then = parseApiDate(value).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

/** Today's date as a YYYY-MM-DD string for date inputs. */
export function todayInput(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Converts an API timestamp/date to a YYYY-MM-DD date-input value. */
export function toDateInput(value: string | null | undefined): string {
  if (!value) return "";
  const date = parseApiDate(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
