/**
 * Readable rows for the Winter survival report.
 *
 * `GET /analytics/survival` groups hives by `COALESCE(stand_id,
 * position_label)` and by the root queen of each hive's current queen
 * (routes_operations.go `survivalAnalytics`), and labels both with the raw
 * id: "Lenoir Apiary · 84721919-360c-…" and "Emergency Cell line · a8b1d8fb".
 * The ids resolve against reads the client already has — each apiary's
 * `canvasLayout.stands` (id → label) and the queen list (id → hive, origin,
 * year) — so the rows are rewritten here and rows that resolve to the same
 * name are merged. Hives with no stand (the server fell back to the position
 * label, or the label is "Unrecorded …") become one "Stand unrecorded" row;
 * queen lines whose root queen is not on the list become "Queen line
 * unknown". Nothing is re-counted: entered and survived are summed as the
 * server gave them.
 */

import type { SurvivalGroup } from "./hooks";

export interface StandRef {
  id: string;
  label: string;
}

/** The slice of a queen the label needs. */
export interface QueenRef {
  id: string;
  origin: string;
  introducedDate: string | null;
  hiveName: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STAND_UNRECORDED = "Stand unrecorded";
export const QUEEN_LINE_UNKNOWN = "Queen line unknown";

function merge(rows: { label: string; key: string; group: SurvivalGroup }[]): SurvivalGroup[] {
  const out = new Map<string, SurvivalGroup>();
  for (const row of rows) {
    const existing = out.get(row.label);
    if (existing) {
      existing.enteredWinter += row.group.enteredWinter;
      existing.survived += row.group.survived;
      continue;
    }
    out.set(row.label, {
      key: row.key,
      label: row.label,
      enteredWinter: row.group.enteredWinter,
      survived: row.group.survived,
      survivalRate: 0,
    });
  }
  return [...out.values()].map((group) => ({
    ...group,
    survivalRate:
      group.enteredWinter > 0 ? (group.survived / group.enteredWinter) * 100 : 0,
  }));
}

/** Fallback rows ("unrecorded", "unknown") go last; the rest keep the server's order. */
function fallbackLast(rows: SurvivalGroup[], fallback: string): SurvivalGroup[] {
  return [
    ...rows.filter((row) => row.label !== fallback),
    ...rows.filter((row) => row.label === fallback),
  ];
}

/**
 * Stand rows: "Stand B" (prefixed with the apiary when the report spans more
 * than one), or "Stand unrecorded" for hives the server grouped by position
 * label because they have no stand.
 */
export function resolveStandRows(
  rows: SurvivalGroup[],
  standsByApiary: ReadonlyMap<string, readonly StandRef[]>,
  apiaryNames: ReadonlyMap<string, string>,
): SurvivalGroup[] {
  const multiApiary = apiaryNames.size > 1;
  const resolved = rows.map((group) => {
    const colon = group.key.indexOf(":");
    const apiaryId = colon === -1 ? "" : group.key.slice(0, colon);
    const stand = colon === -1 ? group.key : group.key.slice(colon + 1);
    const ref = UUID.test(stand)
      ? standsByApiary.get(apiaryId)?.find((entry) => entry.id === stand)
      : undefined;
    if (!ref) return { key: `unrecorded`, label: STAND_UNRECORDED, group };
    const apiary = apiaryNames.get(apiaryId);
    const label =
      multiApiary && apiary ? `${apiary} · Stand ${ref.label}` : `Stand ${ref.label}`;
    return { key: group.key, label, group };
  });
  return fallbackLast(merge(resolved), STAND_UNRECORDED);
}

export function originLabel(origin: string): string {
  const words = origin.replace(/_/g, " ").trim().toLowerCase();
  if (words === "" || words === "unknown") return "queen of unknown origin";
  return `${words} queen`;
}

/**
 * Queen-line rows: the root queen as the beekeeper knows her — the hive she
 * heads (or headed), her origin and her year: "A4 · emergency cell queen,
 * 2026". Lines whose root is not on the queen list, and the server's own
 * "unknown" bucket, are one "Queen line unknown" row.
 */
export function resolveQueenLineRows(
  rows: SurvivalGroup[],
  queens: readonly QueenRef[],
): SurvivalGroup[] {
  const byId = new Map(queens.map((queen) => [queen.id, queen]));
  const resolved = rows.map((group) => {
    const queen = byId.get(group.key);
    if (!queen) return { key: "unknown", label: QUEEN_LINE_UNKNOWN, group };
    const year = queen.introducedDate ? queen.introducedDate.slice(0, 4) : null;
    const who = `${originLabel(queen.origin)}${year ? `, ${year}` : ""}`;
    const label = queen.hiveName ? `${queen.hiveName} · ${who}` : who;
    return { key: group.key, label, group };
  });
  return fallbackLast(merge(resolved), QUEEN_LINE_UNKNOWN);
}
