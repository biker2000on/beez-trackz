/**
 * The WorkItem projection, mirroring `backend/internal/app/work` exactly
 * (design 2026-09-03 §4.2 and §4.8).
 *
 * This file is a transcription, not an interpretation. Today, `/yard/queue`
 * and the recommendation filter are three *filters* over this one shape; the
 * moment one of them re-derives urgency, grouping or permission in the client
 * it becomes a second rule that can disagree with the server, which is the
 * failure `useFieldWork` and `yardQueue` demonstrated.
 */

export type WorkSourceType =
  | "recommendation"
  | "feeding"
  | "lockout"
  | "harvest_ready";

export type WorkPriority = "urgent" | "high" | "normal" | "low";

export type WorkStatus = "open" | "snoozed" | "dismissed" | "done";

/** Offline disposition, decided by the server's offline route manifest. */
export type WorkOffline = "queueable" | "online_only";

export interface WorkContext {
  apiaryId: string | null;
  apiaryName: string | null;
  hiveId: string | null;
  hiveName: string | null;
  locationId: string | null;
}

export interface WorkEvidence {
  text: string;
  sourceType: WorkSourceType;
  sourceId: string;
  observedAt: string | null;
}

/** One thing that can be done about an item, already answered for this actor. */
export interface WorkCommand {
  id: string;
  label: string;
  method: string;
  /** Absolute API path — executed verbatim (§4.2). */
  path: string;
  bodyTemplate: Record<string, unknown>;
  permitted: boolean;
  deniedReason: string | null;
  offline: WorkOffline;
  offlineReason: string | null;
  /** `{clientMutationId}` is substituted per attempt (§5.1). */
  idempotencyKeyTemplate: string;
  /** The action-center key that runs this command (D8). */
  keyboard: string;
}

export interface WorkFreshness {
  origin: "server" | "cache";
  cachedAt: string | null;
  stale: boolean;
}

export interface WorkItem {
  id: string;
  sourceType: WorkSourceType;
  sourceId: string;
  context: WorkContext;
  title: string;
  evidence: WorkEvidence[];
  priority: WorkPriority;
  status: WorkStatus;
  dueAt: string | null;
  supersedes: string[];
  asOf: string;
  freshness: WorkFreshness;
  commands: WorkCommand[];
  sortRank: number;
}

export interface WorkGroup {
  key: string;
  label: string;
  items: WorkItem[];
}

export interface TodayCounts {
  attention: number;
  today: number;
  snoozed: number;
}

/** GET /api/v1/work/today */
export interface TodayResponse {
  asOf: string;
  freshness: WorkFreshness;
  counts: TodayCounts;
  groups: WorkGroup[];
}

export interface YardCounts {
  urgent: number;
  high: number;
  normal: number;
}

export interface WorkYard {
  /** Null for the catch-all that carries hive-less recommendations. */
  apiaryId: string | null;
  apiaryName: string;
  counts: YardCounts;
  items: WorkItem[];
}

/** GET /api/v1/work/yard */
export interface YardResponse {
  asOf: string;
  freshness: WorkFreshness;
  yards: WorkYard[];
}

/**
 * The query string both endpoints share. Every surface in the field slice is
 * this filter plus a choice of read model — nothing else.
 */
export interface WorkFilter {
  status?: WorkStatus[];
  priority?: WorkPriority[];
  sourceType?: WorkSourceType[];
  apiaryId?: string;
}

/** Every item in a Today response, in the server's order. */
export function todayItems(response: TodayResponse | undefined): WorkItem[] {
  return response ? response.groups.flatMap((group) => group.items) : [];
}

/** Every item in a yard response, in the server's order. */
export function yardItems(response: YardResponse | undefined): WorkItem[] {
  return response ? response.yards.flatMap((yard) => yard.items) : [];
}
