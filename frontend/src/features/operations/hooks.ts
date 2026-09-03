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
  hiveId?: string;
  date: string;
  method: string;
  mitesCount: number;
  sampleSize: number | null;
  daysOnBoard: number | null;
  mitesPer100: number | null;
  mitesPerDay: number | null;
  notes: string | null;
}

export interface TreatmentEffect {
  id: string;
  hiveId?: string;
  dateApplied: string;
  dateRemoved?: string | null;
  product: string;
  method: string | null;
  beforeRate: number | null;
  afterRate: number | null;
  beforeRateKind: "per_100" | "per_day" | null;
  afterRateKind: "per_100" | "per_day" | null;
  beforeMitesPer100: number | null;
  afterMitesPer100: number | null;
  efficacyPercent: number | null;
}

export interface VarroaHiveReport {
  counts: MiteCount[];
  treatments: TreatmentEffect[];
  thresholdPer100: number;
  thresholdPerDay: number;
  checkIntervalDays: number;
  overThreshold: boolean;
  latest: MiteCount | null;
}

export interface VarroaFleetHive {
  hiveId: string;
  hiveName: string;
  apiaryId: string;
  apiaryName: string;
  lastCount: MiteCount | null;
  overThreshold: boolean;
}

export interface VarroaFleetReport {
  hives: VarroaFleetHive[];
  overThresholdCount: number;
  treatments: TreatmentEffect[];
  thresholdPer100: number;
  thresholdPerDay: number;
  checkIntervalDays: number;
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

export interface AutopsySummary {
  year: number;
  total: number;
  moisture: number;
  mold: number;
  stores: { label: string; count: number }[];
  clusterPositions: { label: string; count: number }[];
  queenStatuses: { label: string; count: number }[];
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

export interface YardQueueItem {
  kind: "lockout" | "recommendation" | "feeding" | "harvest_ready";
  hiveId: string | null;
  hiveName: string | null;
  title: string;
  detail: string;
  priority: string;
  href: string;
  lockoutUntil?: string | null;
}

export interface YardQueueYard {
  apiaryId: string;
  apiaryName: string;
  items: YardQueueItem[];
}

export interface YardQueue {
  asOf: string;
  yards: YardQueueYard[];
}

export interface FieldIncident {
  id: string;
  incidentType: "robbing" | "yellowjackets" | "bears" | "skunks" | "flood";
  incidentDate: string;
  apiaryId: string;
  apiaryName: string;
  hiveId: string | null;
  hiveName: string | null;
  notes: string | null;
}

export function useYardQueue() {
  return useQuery({
    queryKey: ["operations", "yard-queue"],
    queryFn: () => api.get<YardQueue>("/operations/yard-queue"),
  });
}

export function useFieldIncidents() {
  return useQuery({
    queryKey: ["operations", "incidents"],
    queryFn: () => api.get<FieldIncident[]>("/incidents"),
  });
}

export function useCreateFieldIncident() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      incidentType: FieldIncident["incidentType"];
      incidentDate: string;
      apiaryId: string;
      hiveId?: string;
      notes?: string;
    }) => api.post<{ id: string }>("/incidents", body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["operations", "incidents"] });
      void client.invalidateQueries({ queryKey: ["hives"] });
    },
  });
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
      api.get<VarroaHiveReport>("/analytics/varroa", {
        params: { hiveId },
      }),
  });
}

export function useVarroaFleet() {
  return useQuery({
    queryKey: ["analytics", "varroa", "fleet"],
    queryFn: () => api.get<VarroaFleetReport>("/analytics/varroa"),
  });
}

export function useSurvivalReport(year: number) {
  return useQuery({
    queryKey: ["analytics", "survival", year],
    queryFn: () =>
      api.get<SurvivalReport>("/analytics/survival", { params: { year } }),
  });
}

export function useAutopsySummary(year: number) {
  return useQuery({
    queryKey: ["analytics", "autopsies", year],
    queryFn: () => api.get<AutopsySummary>("/field/autopsy-summary", { params: { year } }),
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

export type MiteMethod = "alcohol_wash" | "sugar_roll" | "sticky_board" | "visual";

export function isWashMethod(method: string): boolean {
  return method === "alcohol_wash" || method === "sugar_roll";
}

export function isBoardMethod(method: string): boolean {
  return method === "sticky_board" || method === "visual";
}

export function miteDisplay(
  row: Pick<MiteCount, "method" | "mitesCount" | "mitesPer100" | "mitesPerDay">,
): { value: number; unit: string; label: string } | null {
  if (isWashMethod(row.method) && row.mitesPer100 != null) {
    return {
      value: row.mitesPer100,
      unit: "mites / 100 bees",
      label: `${row.mitesPer100.toFixed(1)} / 100`,
    };
  }
  if (isBoardMethod(row.method) && row.mitesPerDay != null) {
    return {
      value: row.mitesPerDay,
      unit: "mites / day",
      label: `${row.mitesPerDay.toFixed(1)} / day`,
    };
  }
  return null;
}

export interface MiteCountInput {
  hiveId: string;
  inspectionId?: string;
  date: string;
  method: MiteMethod;
  mitesCount: number;
  sampleSize?: number;
  daysOnBoard?: number;
  notes?: string;
  overwrite?: boolean;
}

/** `hiveId` only targets cache invalidation; the backend rejects unknown
 * fields on PATCH, so drop it from the body before sending. */
function withoutHiveId<T extends { hiveId?: string }>(input: T): Omit<T, "hiveId"> {
  const body = { ...input };
  delete body.hiveId;
  return body;
}

function invalidateMiteQueries(
  client: ReturnType<typeof useQueryClient>,
  hiveId?: string,
) {
  void client.invalidateQueries({ queryKey: ["analytics", "varroa"] });
  void client.invalidateQueries({ queryKey: ["hives"] });
  void client.invalidateQueries({ queryKey: ["inspections"] });
  void client.invalidateQueries({ queryKey: ["mite-counts"] });
  if (hiveId) {
    void client.invalidateQueries({ queryKey: ["hives", "detail", hiveId] });
  }
}

export function useInspectionMiteCounts(inspectionId?: string) {
  return useQuery({
    queryKey: ["mite-counts", "inspection", inspectionId],
    queryFn: () =>
      api.get<MiteCount[]>("/mite-counts", {
        params: { inspectionId },
      }),
    enabled: Boolean(inspectionId),
  });
}

export function useCreateMiteCount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: MiteCountInput) => api.post("/mite-counts", body),
    onSuccess: (_data, input) => invalidateMiteQueries(client, input.hiveId),
  });
}

export function useUpdateMiteCount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: Partial<MiteCountInput> & { id: string; hiveId?: string }) =>
      api.patch(`/mite-counts/${id}`, withoutHiveId(body)),
    onSuccess: (_data, input) => invalidateMiteQueries(client, input.hiveId),
  });
}

export interface EndTreatmentInput {
  id: string;
  hiveId?: string;
  dateRemoved: string | null;
  notes?: string;
}

/** Mark a treatment removed (or clear the removal) so the harvest lockout
 * countdown can start. */
export function useEndTreatment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: EndTreatmentInput) =>
      api.patch<TreatmentEffect>(
        `/treatment-events/${id}`,
        withoutHiveId(body),
      ),
    onSuccess: (_data, input) => {
      void client.invalidateQueries({ queryKey: ["hives"] });
      void client.invalidateQueries({ queryKey: ["operations", "yard-queue"] });
      void client.invalidateQueries({ queryKey: ["analytics", "varroa"] });
      void client.invalidateQueries({ queryKey: ["inspections"] });
      void client.invalidateQueries({ queryKey: ["recommendations"] });
      if (input.hiveId) {
        void client.invalidateQueries({
          queryKey: ["hives", "detail", input.hiveId],
        });
      }
    },
  });
}

export function useDeleteMiteCount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; hiveId?: string }) =>
      api.delete(`/mite-counts/${id}`),
    onSuccess: (_data, input) => invalidateMiteQueries(client, input.hiveId),
  });
}

export interface MiteCountBatchRow {
  method: MiteMethod;
  mitesCount: number;
  sampleSize?: number;
  daysOnBoard?: number;
  notes?: string;
}

/** Replace an inspection's whole mite-count set in one transaction, so a
 * failed edit can never leave a partial mix of old and new rows. */
export function useReplaceInspectionMiteCounts() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      inspectionId: string;
      hiveId?: string;
      counts: MiteCountBatchRow[];
    }) =>
      api.post("/mite-counts/batch", {
        inspectionId: input.inspectionId,
        counts: input.counts,
      }),
    onSuccess: (_data, input) => invalidateMiteQueries(client, input.hiveId),
  });
}

// --- Yard-visit labor ------------------------------------------------------
//
// Yard owns the start/stop control (design 2026-09-03 §6.5, S4); Operation
// Setup owns the `laborTrackingEnabled` flag that turns it on.

export interface LaborSession {
  id: string;
  apiaryId: string | null;
  apiaryName: string | null;
  startedAt: string;
  stoppedAt: string | null;
  minutes: number;
  notes: string | null;
  open: boolean;
}

export function useLaborCurrent() {
  return useQuery({
    queryKey: ["ops", "labor", "current"],
    queryFn: () =>
      api.get<{ enabled: boolean; current: LaborSession | null }>(
        "/ops/labor/current",
      ),
  });
}

export function useLaborList() {
  return useQuery({
    queryKey: ["ops", "labor"],
    queryFn: () => api.get<{ items: LaborSession[] }>("/ops/labor"),
  });
}

export function useLaborStart() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload?: { apiaryId?: string | null; notes?: string }) =>
      api.post<LaborSession>("/ops/labor/start", payload ?? {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ops", "labor"] });
    },
  });
}

export function useLaborStop() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload?: { id?: string; notes?: string }) =>
      api.post<LaborSession>("/ops/labor/stop", payload ?? {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ops", "labor"] });
    },
  });
}
