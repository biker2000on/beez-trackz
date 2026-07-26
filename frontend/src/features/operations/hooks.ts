"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export interface TimelinePhoto {
  id: string;
  url: string;
  caption: string | null;
}

export interface HiveTimelineEntry {
  id: string;
  type:
    | "inspection"
    | "feeding"
    | "treatment"
    | "mite_count"
    | "queen_event"
    | "harvest"
    | "split"
    | "move";
  date: string;
  title: string;
  details: string | null;
  photos: TimelinePhoto[];
  meta: Record<string, unknown>;
}

export interface MiteCount {
  id: string;
  date: string;
  method: string;
  mitesCount: number;
  sampleSize: number | null;
  mitesPer100: number | null;
  notes: string | null;
}

export interface TreatmentEffect {
  id: string;
  dateApplied: string;
  product: string;
  method: string | null;
  beforeMitesPer100: number | null;
  afterMitesPer100: number | null;
  efficacyPercent: number | null;
}

export interface SurvivalGroup {
  key: string;
  label: string;
  enteredWinter: number;
  survived: number;
  survivalRate: number;
}

export interface SurvivalReport {
  winterYear: number;
  enteredWinter: number;
  survived: number;
  survivalRate: number;
  byApiary: SurvivalGroup[];
  byStand: SurvivalGroup[];
  byQueenLine: SurvivalGroup[];
}

export interface YieldReport {
  year: number;
  totalPounds: number;
  byHive: {
    hiveId: string;
    hiveName: string;
    apiaryId: string;
    apiaryName: string;
    pounds: number;
  }[];
  byApiary: { apiaryId: string; apiaryName: string; pounds: number }[];
  byYear: { year: number; pounds: number }[];
}

export interface EconomicsReport {
  year: number;
  apiaries: {
    apiaryId: string;
    apiaryName: string;
    harvestedPounds: number;
    producingHives: number;
    revenueAllocated: number;
    expenses: number;
    margin: number;
    poundsPerHive: number;
    feedCostPerColony: number;
    treatmentCostPerColony: number;
    enteredWinter: number;
    survivedWinter: number;
    winterSurvivalRate: number;
    splitsCreated: number;
    splitChildrenSurviving: number;
    queensIntroduced: number;
    introducedQueensActive: number;
  }[];
}

export function useHiveTimeline(hiveId: string) {
  return useQuery({
    queryKey: ["hives", "detail", hiveId, "timeline"],
    queryFn: () =>
      api.get<HiveTimelineEntry[]>(`/hives/${hiveId}/timeline`),
  });
}

export function useVarroaAnalytics(hiveId: string) {
  return useQuery({
    queryKey: ["analytics", "varroa", hiveId],
    queryFn: () =>
      api.get<{ counts: MiteCount[]; treatments: TreatmentEffect[] }>(
        "/analytics/varroa",
        { params: { hiveId } },
      ),
  });
}

export function useSurvivalReport(year: number) {
  return useQuery({
    queryKey: ["analytics", "survival", year],
    queryFn: () =>
      api.get<SurvivalReport>("/analytics/survival", { params: { year } }),
  });
}

export function useYieldReport(year: number) {
  return useQuery({
    queryKey: ["analytics", "yield", year],
    queryFn: () =>
      api.get<YieldReport>("/analytics/yield", { params: { year } }),
  });
}

export function useEconomicsReport(year: number) {
  return useQuery({
    queryKey: ["analytics", "economics", year],
    queryFn: () =>
      api.get<EconomicsReport>("/analytics/economics", {
        params: { year },
      }),
  });
}

export interface MiteCountInput {
  hiveId: string;
  inspectionId?: string;
  date: string;
  method: "alcohol_wash" | "sugar_roll" | "sticky_board" | "visual";
  mitesCount: number;
  sampleSize?: number;
  notes?: string;
}

export function useCreateMiteCount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: MiteCountInput) => api.post("/mite-counts", body),
    onSuccess: (_data, input) => {
      void client.invalidateQueries({
        queryKey: ["analytics", "varroa", input.hiveId],
      });
      void client.invalidateQueries({ queryKey: ["hives", "detail", input.hiveId] });
    },
  });
}
