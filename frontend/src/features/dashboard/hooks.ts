"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

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
