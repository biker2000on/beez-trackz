/**
 * The Today roll-up: one card per hive, built in the client from the server's
 * flat `WorkItem` list without re-deriving what any item *is*.
 *
 * What is decided here, and only here:
 *
 *  - **Card** — items with the same `context.hiveId` share a card, in the
 *    order the server first listed that hive. A hive-less item is its own
 *    card.
 *  - **Bucket** — Urgent / This week / Later, a rename of the server's
 *    priority: `urgent` → Urgent, `high` → This week, `normal`/`low` → Later.
 *    A card takes the highest priority among its visible items.
 *  - **Stale** — a generated item whose evidence is older than one season
 *    (`STALE_AFTER_DAYS`). The projection carries `observedAt`, but for a
 *    recommendation that is the date the rule *ran*, not the date of the
 *    observation it cites ("Feeder placed 724 days ago" generated on
 *    2026-08-11). So the age is read from the largest "N days" in the item's
 *    own words, and `observedAt` is only the fallback when no such number is
 *    present. Stale items are hidden by default behind "Show stale (n)".
 *  - **Primary action** — Log inspection when the card's top item asks for
 *    an inspection, otherwise Open hive.
 *  - **Field-actionable** — what the Visit queue keeps: an item on a hive
 *    that is not a lockout notice.
 */

import type { WorkItem, WorkPriority } from "./types";

export const STALE_AFTER_DAYS = 180;

export type WorkBucket = "urgent" | "week" | "later";

export const BUCKETS: { key: WorkBucket; label: string }[] = [
  { key: "urgent", label: "Urgent" },
  { key: "week", label: "This week" },
  { key: "later", label: "Later" },
];

const PRIORITY_RANK: Record<WorkPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export function bucketOf(priority: WorkPriority): WorkBucket {
  if (priority === "urgent") return "urgent";
  if (priority === "high") return "week";
  return "later";
}

const DAYS = /(\d+)\s+days?\b/gi;

/** The largest "N days" the item states about itself, or null. */
export function statedAgeDays(item: WorkItem): number | null {
  const text = [item.title, ...item.evidence.map((entry) => entry.text)].join(
    " ",
  );
  let max: number | null = null;
  for (const match of text.matchAll(DAYS)) {
    const days = Number(match[1]);
    if (Number.isFinite(days) && (max === null || days > max)) max = days;
  }
  return max;
}

/**
 * How old the item's evidence is, in days: the stated age when the item
 * states one, else the age of its most recent `observedAt` at `asOf`.
 */
export function evidenceAgeDays(item: WorkItem, asOf: string): number | null {
  const stated = statedAgeDays(item);
  if (stated !== null) return stated;
  const reference = new Date(asOf).getTime();
  if (Number.isNaN(reference)) return null;
  let newest: number | null = null;
  for (const entry of item.evidence) {
    if (!entry.observedAt) continue;
    const observed = new Date(entry.observedAt).getTime();
    if (Number.isNaN(observed)) continue;
    if (newest === null || observed > newest) newest = observed;
  }
  if (newest === null) return null;
  return Math.floor((reference - newest) / 86_400_000);
}

export function isStale(item: WorkItem, asOf: string): boolean {
  const age = evidenceAgeDays(item, asOf);
  return age !== null && age >= STALE_AFTER_DAYS;
}

/** What the Visit queue keeps: something to do standing at a hive. */
export function isFieldActionable(item: WorkItem): boolean {
  return item.context.hiveId !== null && item.sourceType !== "lockout";
}

export type PrimaryAction = "open-hive" | "log-inspection";

export interface HiveCard {
  key: string;
  hiveId: string | null;
  hiveName: string | null;
  apiaryId: string | null;
  apiaryName: string | null;
  /** Items shown on the card, in the server's order. */
  items: WorkItem[];
  /** Items hidden as stale (empty when stale items are shown). */
  hidden: WorkItem[];
  priority: WorkPriority;
  bucket: WorkBucket;
  primary: PrimaryAction | null;
}

function cardKey(item: WorkItem): string {
  return item.context.hiveId ? `hive:${item.context.hiveId}` : `item:${item.id}`;
}

function primaryFor(top: WorkItem | undefined): PrimaryAction | null {
  if (!top || !top.context.hiveId) return null;
  return /inspect/i.test(top.title) ? "log-inspection" : "open-hive";
}

/**
 * Roll a flat list into hive cards. Cards whose every item is hidden are
 * dropped; `staleCount` says how many items that hid.
 */
export function rollUp(
  items: WorkItem[],
  asOf: string,
  options: { showStale: boolean },
): { cards: HiveCard[]; staleCount: number } {
  const byKey = new Map<string, { visible: WorkItem[]; hidden: WorkItem[] }>();
  let staleCount = 0;
  for (const item of items) {
    const key = cardKey(item);
    const bucket = byKey.get(key) ?? { visible: [], hidden: [] };
    if (!byKey.has(key)) byKey.set(key, bucket);
    const stale = isStale(item, asOf);
    if (stale) staleCount += 1;
    if (stale && !options.showStale) bucket.hidden.push(item);
    else bucket.visible.push(item);
  }
  const cards: HiveCard[] = [];
  for (const [key, { visible, hidden }] of byKey) {
    if (visible.length === 0) continue;
    const top = visible[0];
    const priority = visible
      .map((item) => item.priority)
      .reduce((best, next) =>
        PRIORITY_RANK[next] < PRIORITY_RANK[best] ? next : best,
      );
    cards.push({
      key,
      hiveId: top.context.hiveId,
      hiveName: top.context.hiveName,
      apiaryId: top.context.apiaryId,
      apiaryName: top.context.apiaryName,
      items: visible,
      hidden,
      priority,
      bucket: bucketOf(priority),
      primary: primaryFor(top),
    });
  }
  return { cards, staleCount };
}

export interface BucketSection {
  key: WorkBucket;
  label: string;
  cards: HiveCard[];
}

/** Cards by bucket, Urgent first; empty buckets are left out. */
export function bucketCards(cards: HiveCard[]): BucketSection[] {
  return BUCKETS.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    cards: cards.filter((card) => card.bucket === bucket.key),
  })).filter((section) => section.cards.length > 0);
}

/**
 * One short phrase per item for the card's summary line: the item's own
 * title, plus the age it states ("Check the feeder · 724 d").
 */
export function itemPhrase(item: WorkItem): string {
  const days = statedAgeDays(item);
  return days === null ? item.title : `${item.title} · ${days} d`;
}

export function cardSummary(card: HiveCard): string {
  return card.items.map(itemPhrase).join("  ·  ");
}
