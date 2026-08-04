"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import {
  useFeedingStatus,
  type FeedingStatusRow,
} from "@/features/feedings/hooks";

// --- dashboard-only response shapes ---

export interface Recommendation {
  id: string;
  hiveId: string | null;
  type: string;
  message: string;
  priority: "urgent" | "high" | "normal" | "low" | string;
  dismissed: boolean;
  createdAt: string;
  hiveName: string | null;
}

export interface FrameSummary {
  standalone: {
    drawn: number;
    fresh: number;
    unspecified: number;
    total: number;
  };
  boxFrameCapacity: number;
  boxBreakdown: {
    boxType: string;
    framesPerBox: number;
    deployedBoxes: number;
    totalFrameCapacity: number;
  }[];
  grandTotal: number;
}

export interface HoneyInventoryRow {
  jarSizeId: string;
  label: string;
  honeyOz: number | null;
  defaultPrice: number | null;
  jarred: number;
  sold: number;
  givenAway: number;
  adjusted: number;
  onHand: number;
}

export interface HoneyOverview {
  totalHarvestedLbs: number;
  jarredLbs: number;
  bulkUsedLbs: number;
  lossLbs: number;
  bulkOnHandLbs: number;
  totalRevenue: number;
  jarsSold: number;
  inventory: HoneyInventoryRow[];
}

export function useRecommendations() {
  return useQuery({
    queryKey: ["recommendations"],
    queryFn: () => api.get<Recommendation[]>("/recommendations"),
  });
}

export function useFrameSummary() {
  return useQuery({
    queryKey: ["equipment", "frame-summary"],
    queryFn: () => api.get<FrameSummary>("/equipment/frame-summary"),
  });
}

export function useHoneyOverview() {
  return useQuery({
    queryKey: ["honey", "overview"],
    queryFn: () => api.get<HoneyOverview>("/honey/overview"),
  });
}

// --- work in front of the beekeeper ---------------------------------------

/**
 * One item of work: what to do, and the observation that says why. Every
 * dashboard row is built from this, so nothing on the dashboard can be
 * generic advice without evidence behind it.
 */
export interface FieldItem {
  id: string;
  kind: "feeding" | "recommendation";
  hiveId: string | null;
  hiveName: string | null;
  /** The concrete action, e.g. "Verify and close". */
  action: string;
  /** The evidence, e.g. "Feeder on A3 open 94 days with no refill". */
  evidence: string;
  priority: "urgent" | "high" | "normal" | "low";
  /** Set for feeding items: the feeding the action applies to. */
  feedingId?: string | null;
  /** Set for feeding items: whether the feeder record is unverified. */
  unverified?: boolean;
}

const RECOMMENDATION_ACTIONS: Record<string, string> = {
  inspection_due: "Inspect this hive",
  treatment_reminder: "Review treatment",
  equipment_needed: "Add equipment",
  seasonal_prep: "Seasonal prep",
};

function feedingItem(row: FeedingStatusRow): FieldItem {
  return {
    id: `feeding:${row.hiveId}`,
    kind: "feeding",
    hiveId: row.hiveId,
    hiveName: row.hiveName,
    action: row.action,
    evidence: row.evidence,
    priority: row.state === "attention" ? "urgent" : "high",
    feedingId: row.actionFeedingId,
    unverified: row.unverifiedFeeders > 0,
  };
}

function recommendationItem(rec: Recommendation): FieldItem {
  return {
    id: `rec:${rec.id}`,
    kind: "recommendation",
    hiveId: rec.hiveId,
    hiveName: rec.hiveName,
    action: RECOMMENDATION_ACTIONS[rec.type] ?? "Review",
    evidence: rec.message,
    priority: (rec.priority as FieldItem["priority"]) ?? "normal",
  };
}

/**
 * Splits everything the dashboard knows about into what is wrong now
 * (`attention`) and the visit checklist (`today`), with no item in both.
 *
 * `feeder_check` recommendations are dropped: the feeding-status row covers
 * the same feeder with a specific age and a real action, and the generic
 * reminder would only repeat it.
 */
export function useFieldWork() {
  const recommendations = useRecommendations();
  const feeding = useFeedingStatus();

  const feedingRows = feeding.data ?? [];
  const recs = (recommendations.data ?? []).filter(
    (rec) => rec.type !== "feeder_check",
  );

  const attention: FieldItem[] = [
    ...feedingRows
      .filter((row) => row.state === "attention")
      .map(feedingItem),
    ...recs
      .filter((rec) => rec.priority === "urgent" || rec.priority === "high")
      .map(recommendationItem),
  ];

  const today: FieldItem[] = [
    ...feedingRows.filter((row) => row.state === "stale").map(feedingItem),
    ...recs
      .filter((rec) => rec.priority !== "urgent" && rec.priority !== "high")
      .map(recommendationItem),
  ];

  return {
    attention,
    today,
    isPending: recommendations.isPending || feeding.isPending,
    isError: recommendations.isError || feeding.isError,
  };
}
