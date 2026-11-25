/**
 * Apiary activity: the visit-day history behind the apiary Timeline tab.
 *
 * Mirrors Contract 1 in `docs/plans/2026-11-25-atlas-review-contracts.md`
 * (`GET /api/v1/apiaries/{id}/activity`). Every type and every reading of an
 * event's `meta` lives in this one file, so if the backend's shape differs
 * from the contract only this file (and `use-apiary-activity.ts` for the
 * request) has to change.
 */

/** Values the `types` query param accepts (Contract 1). */
export const ACTIVITY_TYPES = [
  "inspection",
  "feeding",
  "treatment",
  "mite_count",
  "queen",
  "split",
  "harvest",
  "move",
  "status",
  "apiary_observation",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/**
 * The `type` an event carries. Contract 1 reuses the hive timeline's event
 * shape, where queen events are `queen_event`; the filter value is `queen`.
 * Both spellings are accepted and normalized by `activityTypeOf`.
 */
export type ActivityEventType = Exclude<ActivityType, "apiary_observation"> | "queen_event";

export interface ActivityPhoto {
  id: string;
  url: string;
  caption: string | null;
}

/** One event on one hive; the same shape `GET /hives/{id}/timeline` returns. */
export interface ActivityEvent {
  id: string;
  type: ActivityEventType | (string & {});
  title: string;
  details: string | null;
  meta: Record<string, unknown> | null;
  photos: ActivityPhoto[] | null;
  /** Present on hive-timeline entries; not required on activity events. */
  date?: string;
}

export interface ActivityHive {
  hiveId: string;
  positionLabel: string;
  status: string;
  isArchived: boolean;
  installedDate: string | null;
  deadoutDate: string | null;
  standId: string | null;
  slotRow: number | null;
  slotCol: number | null;
  events: ActivityEvent[];
}

export interface ApiaryObservationEntry {
  id: string;
  observedAt: string;
  notes: string;
}

export interface ActivityDay {
  /** YYYY-MM-DD */
  date: string;
  apiaryObservations: ApiaryObservationEntry[];
  hives: ActivityHive[];
}

export interface ApiaryActivity {
  apiaryId: string;
  from: string;
  to: string;
  /** Newest first; days without events are omitted. */
  days: ActivityDay[];
}

export interface ActivityQuery {
  /** YYYY-MM-DD, inclusive. Omitted: `to` minus 365 days. */
  from?: string;
  /** YYYY-MM-DD, inclusive. Omitted: today. */
  to?: string;
  /** Omitted or empty: every type. */
  types?: readonly ActivityType[];
}

/** The longest range the endpoint accepts (it answers 400 past three years). */
export const MAX_RANGE_DAYS = 365 * 3;

// --- normalizing ---------------------------------------------------------

/** The filter bucket an event belongs to (`queen_event` reads as `queen`). */
export function activityTypeOf(event: Pick<ActivityEvent, "type">): ActivityType | null {
  if (event.type === "queen_event") return "queen";
  return (ACTIVITY_TYPES as readonly string[]).includes(event.type)
    ? (event.type as ActivityType)
    : null;
}

function metaValue(event: ActivityEvent, key: string): unknown {
  return event.meta && typeof event.meta === "object" ? event.meta[key] : undefined;
}

function metaNumber(event: ActivityEvent, key: string): number | null {
  const value = metaValue(event, key);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function metaString(event: ActivityEvent, key: string): string | null {
  const value = metaValue(event, key);
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// --- words ---------------------------------------------------------------

/** Filter-chip labels, in the order the chips are drawn. */
export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  inspection: "Inspections",
  feeding: "Feedings",
  treatment: "Treatments",
  mite_count: "Mite counts",
  status: "Status",
  queen: "Queen events",
  apiary_observation: "Apiary notes",
  harvest: "Harvests",
  split: "Splits",
  move: "Moves",
};

/**
 * Queen events as words. The database stores `observed`, `introduced`,
 * `superseded`, `missing`, `dead` and `requeened`; the hive timeline's title
 * is "Queen " plus the raw value.
 */
const QUEEN_EVENT_WORDS: Record<string, string> = {
  observed: "Queen seen",
  seen: "Queen seen",
  introduced: "Queen introduced",
  superseded: "Supersedure",
  supersedure: "Supersedure",
  missing: "Queen missing",
  dead: "Queen dead",
  requeened: "Requeened",
  marked: "Queen marked",
};

/** The raw queen event value: `meta.eventType` if sent, else from the title. */
function queenEventValue(event: ActivityEvent): string | null {
  const fromMeta = metaString(event, "eventType");
  if (fromMeta) return fromMeta.toLowerCase();
  const match = /^queen[\s_]+(.+)$/i.exec(event.title.trim());
  return match ? match[1].trim().toLowerCase().replace(/\s+/g, "_") : null;
}

/** "Queen seen", "Supersedure", "Requeened" — never "Queen superseded". */
export function queenEventLabel(event: ActivityEvent): string {
  const value = queenEventValue(event);
  if (!value) return event.title;
  const known = QUEEN_EVENT_WORDS[value];
  if (known) return known;
  const words = value.replace(/_/g, " ");
  return `Queen ${words}`;
}

const STATUS_WORDS: Record<string, string> = {
  dead: "Dead-out",
  sold: "Sold",
  combined: "Combined",
  active: "Reactivated",
  archived: "Archived",
};

/** Mite counts read as "4/300" (alcohol wash) or "12 mites" (board). */
export function miteCountText(event: ActivityEvent): string {
  const count = metaNumber(event, "mitesCount");
  const sample = metaNumber(event, "sampleSize");
  if (count == null) return event.details ?? "Mite count";
  if (sample != null && sample > 0) return `${count}/${sample}`;
  const days = metaNumber(event, "daysOnBoard");
  return days != null && days > 0
    ? `${count} mites · ${days} d board`
    : `${count} mites`;
}

/** First clause of a note, short enough for a chip. */
export function oneLiner(text: string | null | undefined, max = 72): string {
  if (!text) return "";
  const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  const clean = firstLine.replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(clean)?.[1] ?? clean;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

export interface EventChip {
  type: ActivityType | null;
  /** The bold lead word: "Inspected", "Fed", "Oxalic acid", "Mites". */
  lead: string;
  /** The rest of the one-liner, possibly empty. */
  text: string;
}

/**
 * One compact line per event: the inspection's one-liner, the feeding, the
 * treatment product, the mite count as n/300, the status change.
 */
export function eventChip(event: ActivityEvent): EventChip {
  const type = activityTypeOf(event);
  switch (type) {
    case "inspection":
      return { type, lead: "Inspected", text: oneLiner(event.details) };
    case "feeding":
      return { type, lead: "Fed", text: oneLiner(event.details, 48) };
    case "treatment": {
      const product = event.title.replace(/^treatment:\s*/i, "").trim();
      return {
        type,
        lead: product || "Treatment",
        text: oneLiner(event.details, 40),
      };
    }
    case "mite_count":
      return { type, lead: "Mites", text: miteCountText(event) };
    case "queen":
      return { type, lead: queenEventLabel(event), text: oneLiner(event.details, 48) };
    case "status": {
      const status = metaString(event, "status");
      return {
        type,
        lead: (status && STATUS_WORDS[status]) || event.title || "Status change",
        text: oneLiner(event.details, 48),
      };
    }
    case "harvest":
      return { type, lead: "Harvest", text: event.details ?? "" };
    case "split":
    case "move":
      return { type, lead: event.title, text: oneLiner(event.details, 40) };
    default:
      return { type: null, lead: event.title, text: oneLiner(event.details) };
  }
}

/** Full title for an expanded event row ("Supersedure", "Treatment: Oxalic acid"). */
export function eventTitle(event: ActivityEvent): string {
  return activityTypeOf(event) === "queen" ? queenEventLabel(event) : event.title;
}

// --- dates ---------------------------------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDay(value: string | null | undefined): value is string {
  if (!value || !DAY_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Calendar arithmetic on YYYY-MM-DD strings, free of the browser's timezone. */
export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + delta));
  return date.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Today in the browser's calendar, as YYYY-MM-DD. */
export function todayDay(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const dayHeading = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** "Sat, Sep 13, 2025" for a YYYY-MM-DD day. */
export function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : dayHeading.format(date);
}
