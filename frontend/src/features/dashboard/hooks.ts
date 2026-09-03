"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
/**
 * What is left of the dashboard's own data layer.
 *
 * `useFieldWork` lived here: a client-side assembler over `/recommendations`
 * and `/feedings/status` that split the result into "needs attention" and
 * "today's field actions". It is deleted (design 2026-09-03 §4.1). The split
 * is now a grouping over one server-assigned `sortRank`
 * (`backend/internal/app/work`), which is what stops Today and the yard queue
 * from disagreeing about the same hive; `features/work` reads it.
 *
 * The two summaries below stay because the widgets that use them are still
 * on this page — they move to `/equipment` and `/production` in wave 5, when
 * those routes exist.
 */

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
