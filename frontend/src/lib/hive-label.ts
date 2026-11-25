import type { Hive } from "@/features/hives/hooks";

/**
 * Position labels (A1–D4) are reused: when a colony dies, is sold, or is
 * combined, the next colony in that spot gets a new hive record with the same
 * label. These helpers keep pickers, matchers and history rows from showing
 * two indistinguishable "A4"s.
 */
export type HiveLabelSource = Pick<
  Hive,
  "id" | "positionLabel" | "status" | "isArchived" | "installedDate" | "deadoutDate"
>;

/** The one hive per label that new records may be written to. */
export function isActiveHive(hive: Pick<Hive, "status" | "isArchived">): boolean {
  return hive.status === "active" && !hive.isArchived;
}

/** Hives a capture, picker or matcher may offer for new records. */
export function activeHives<T extends Pick<Hive, "status" | "isArchived">>(
  hives: readonly T[],
): T[] {
  return hives.filter(isActiveHive);
}

const monthYear = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function formatMonthYear(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : monthYear.format(date);
}

/**
 * "A4" when no other hive in `all` shares the label. Otherwise the active hive
 * reads "A4 · since May 2026" and retired ones read "A4 (dead Apr 2026)",
 * "A4 (sold)" or "A4 (combined)".
 */
export function hiveDisplayLabel(
  hive: HiveLabelSource,
  all: readonly HiveLabelSource[],
): string {
  const label = hive.positionLabel;
  const shared = all.some((other) => other.id !== hive.id && other.positionLabel === label);
  if (!shared) return label;

  if (isActiveHive(hive)) {
    const since = formatMonthYear(hive.installedDate);
    return since ? `${label} · since ${since}` : label;
  }
  if (hive.status === "dead") {
    const died = formatMonthYear(hive.deadoutDate);
    return died ? `${label} (dead ${died})` : `${label} (dead)`;
  }
  if (hive.status === "active") {
    // Active but archived: treat as retired for labelling.
    return `${label} (archived)`;
  }
  return `${label} (${hive.status})`;
}
