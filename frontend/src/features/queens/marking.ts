/**
 * International queen-marking colors, keyed by introduction year:
 * years ending 0/5 → blue, 1/6 → white, 2/7 → yellow, 3/8 → red, 4/9 → green.
 */

export interface MarkingColor {
  name: string;
  /** Dot fill. Hex so it renders identically in both themes. */
  color: string;
  /** White needs an outline to stay visible on light backgrounds. */
  needsBorder: boolean;
}

const MARKING_COLORS: MarkingColor[] = [
  { name: "Blue", color: "#2563eb", needsBorder: false },
  { name: "White", color: "#f8fafc", needsBorder: true },
  { name: "Yellow", color: "#eab308", needsBorder: false },
  { name: "Red", color: "#dc2626", needsBorder: false },
  { name: "Green", color: "#16a34a", needsBorder: false },
];

/** Marking color for an introduction year (e.g. 2024 → green). */
export function markingColorForYear(year: number): MarkingColor {
  return MARKING_COLORS[((year % 5) + 5) % 5];
}

/** Marking color from an ISO date string; null when no date is set. */
export function markingColorForDate(
  date: string | null,
): (MarkingColor & { year: number }) | null {
  if (!date) return null;
  // Take the year from the string's server-local date part — converting
  // through the browser timezone can shift New Year's-adjacent dates.
  const year = /^\d{4}/.test(date)
    ? Number(date.slice(0, 4))
    : new Date(date).getFullYear();
  if (Number.isNaN(year)) return null;
  return { ...markingColorForYear(year), year };
}
