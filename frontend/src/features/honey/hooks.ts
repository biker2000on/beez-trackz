"use client";

/** React Query hooks for the honey ledger, harvests, and harvest sessions. */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type {
  ApiaryOption,
  HarvestRow,
  HarvestSessionDetail,
  HarvestSessionRow,
  HiveOption,
  HoneyInventoryRow,
  HoneyOverview,
  HoneySale,
  TimelineEntry,
} from "./types";

// --- queries ---

export function useHoneyOverview() {
  return useQuery({
    queryKey: ["honey", "overview"],
    queryFn: () => api.get<HoneyOverview>("/honey/overview"),
  });
}

export function useJarInventory() {
  return useQuery({
    queryKey: ["honey", "inventory"],
    queryFn: () => api.get<HoneyInventoryRow[]>("/honey/inventory"),
  });
}

export function useHoneyTimeline(limit = 100) {
  return useQuery({
    queryKey: ["honey", "timeline", limit],
    queryFn: () =>
      api.get<TimelineEntry[]>("/honey/timeline", { params: { limit } }),
  });
}

export function useHoneySales() {
  return useQuery({
    queryKey: ["honey", "sales"],
    queryFn: () => api.get<HoneySale[]>("/honey/sales"),
  });
}

export function useSaleLocations() {
  return useQuery({
    queryKey: ["honey", "sale-locations"],
    queryFn: () => api.get<string[]>("/honey/sale-locations"),
  });
}

export function useHarvests() {
  return useQuery({
    queryKey: ["harvests"],
    queryFn: () => api.get<HarvestRow[]>("/harvests"),
  });
}

export function useHarvestSessions() {
  return useQuery({
    queryKey: ["harvest-sessions"],
    queryFn: () => api.get<HarvestSessionRow[]>("/harvest-sessions"),
  });
}

export function useHarvestSession(id: string) {
  return useQuery({
    queryKey: ["harvest-sessions", id],
    queryFn: () => api.get<HarvestSessionDetail>(`/harvest-sessions/${id}`),
  });
}

export function useHiveOptions() {
  return useQuery({
    queryKey: ["hives", "options"],
    queryFn: () => api.get<HiveOption[]>("/hives"),
  });
}

export function useApiaryOptions() {
  return useQuery({
    queryKey: ["apiaries", "options"],
    queryFn: () => api.get<ApiaryOption[]>("/apiaries"),
  });
}

// --- mutation helper ---

interface HoneyMutationOptions<TVars, TData> {
  mutationFn: (vars: TVars) => Promise<TData>;
  successMessage: string;
  /** Extra query keys to invalidate beyond the ["honey"] prefix. */
  invalidate?: QueryKey[];
  /** Skip the error toast (the caller surfaces the error inline). */
  silentError?: boolean;
}

function useHoneyMutation<TVars, TData = unknown>(
  options: HoneyMutationOptions<TVars, TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: options.mutationFn,
    onSuccess: () => {
      toast.success(options.successMessage);
      queryClient.invalidateQueries({ queryKey: ["honey"] });
      for (const key of options.invalidate ?? []) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (error) => {
      if (!options.silentError) {
        toast.error(error instanceof Error ? error.message : "Request failed");
      }
    },
  });
}

// --- movement mutations ---

export interface JarLineBody {
  jarSizeId: string;
  quantity: number;
}

export interface JarringBody {
  date: string;
  lines: JarLineBody[];
  lossLbs?: number;
  lossReason?: string;
  notes?: string;
}

export function useRecordJarring() {
  return useHoneyMutation({
    mutationFn: (body: JarringBody) => api.post("/honey/jarring", body),
    successMessage: "Jarring recorded",
  });
}

export interface BulkMovementBody {
  date: string;
  kind: "bulk_use" | "loss";
  amountLbs: number;
  reason?: string;
  notes?: string;
}

export function useRecordBulkMovement() {
  return useHoneyMutation({
    mutationFn: (body: BulkMovementBody) =>
      api.post("/honey/bulk-movements", body),
    successMessage: "Movement recorded",
  });
}

export interface GiveAwayBody {
  date: string;
  lines: JarLineBody[];
  reason?: string;
  notes?: string;
}

export function useRecordGiveAway() {
  return useHoneyMutation({
    mutationFn: (body: GiveAwayBody) => api.post("/honey/give-away", body),
    successMessage: "Give-away recorded",
  });
}

export interface JarAdjustmentBody {
  date: string;
  lines: { jarSizeId: string; delta: number }[];
  reason?: string;
}

export function useAdjustJars() {
  return useHoneyMutation({
    mutationFn: (body: JarAdjustmentBody) =>
      api.post("/honey/jar-adjustments", body),
    successMessage: "Jar counts adjusted",
  });
}

// --- sales mutations ---

export interface SaleBody {
  date: string;
  location?: string;
  customerId?: string;
  harvestLotId?: string;
  customerName?: string;
  channel?: "farm_stand" | "farmers_market" | "wholesale" | "pickup" | "online" | "gift" | "consignment" | "direct";
  paymentMethod?: "cash" | "card" | "check" | "venmo" | "paypal" | "invoice" | "other";
  discountAmount?: number;
  amountPaid?: number;
  orderStatus?: "draft" | "pending" | "paid" | "fulfilled" | "cancelled";
  orderNumber?: string;
  dueDate?: string;
  wholesalePriceListId?: string;
  lines: { jarSizeId: string; quantity: number; unitPrice: number }[];
  notes?: string;
}

export function useRecordSale() {
  // Errors (e.g. "Not enough Pint: need 4, have 2") surface inline in the
  // dialog instead of a toast.
  return useHoneyMutation({
    mutationFn: (body: SaleBody) => api.post("/honey/sales", body),
    successMessage: "Sale recorded",
    silentError: true,
  });
}

export function useDeleteSale() {
  return useHoneyMutation({
    mutationFn: (id: string) => api.delete(`/honey/sales/${id}`),
    successMessage: "Sale deleted",
  });
}

/** Delete one or more timeline entries (movements and/or sales). */
export function useDeleteTimelineEntries() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (entries: { id: string; type: string }[]) => {
      const results = await Promise.allSettled(
        entries.map((entry) =>
          entry.type === "sale"
            ? api.delete(`/honey/sales/${entry.id}`)
            : api.delete(`/honey/movements/${entry.id}`),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        throw new Error(`${failed} of ${entries.length} deletions failed`);
      }
      return entries.length;
    },
    onSuccess: (count) => {
      toast.success(count === 1 ? "Entry deleted" : `${count} entries deleted`);
      queryClient.invalidateQueries({ queryKey: ["honey"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Delete failed");
      // Some deletions may have succeeded before the failure.
      queryClient.invalidateQueries({ queryKey: ["honey"] });
    },
  });
}

// --- harvest + session mutations ---

export interface SessionBody {
  apiaryId: string;
  date: string;
  notes?: string;
}

export function useCreateSession() {
  return useHoneyMutation<SessionBody, { id: string }>({
    mutationFn: (body) => api.post<{ id: string }>("/harvest-sessions", body),
    successMessage: "Session created",
    invalidate: [["harvest-sessions"]],
  });
}

export interface HarvestBody {
  hiveId: string;
  date: string;
  superWeightBefore: number;
  superWeightAfter: number;
  notes?: string;
}

export function useCreateHarvest() {
  return useHoneyMutation({
    mutationFn: (body: HarvestBody) => api.post("/harvests", body),
    successMessage: "Harvest recorded",
    invalidate: [["harvests"], ["harvest-sessions"]],
  });
}

export interface SessionEntryBody {
  hiveId: string;
  superWeightBefore: number;
  superWeightAfter: number;
  notes?: string;
}

export function useAddSessionEntry(sessionId: string) {
  return useHoneyMutation({
    mutationFn: (body: SessionEntryBody) =>
      api.post(`/harvest-sessions/${sessionId}/entries`, body),
    successMessage: "Entry added",
    invalidate: [["harvest-sessions"], ["harvests"]],
  });
}

export function useTrueUpSession(sessionId: string) {
  return useHoneyMutation({
    mutationFn: (totalExtractedWeight: number) =>
      api.post(`/harvest-sessions/${sessionId}/true-up`, {
        totalExtractedWeight,
      }),
    successMessage: "Extracted weight saved",
    invalidate: [["harvest-sessions"]],
  });
}

export function useDeleteSessionEntry() {
  return useHoneyMutation({
    mutationFn: (entryId: string) =>
      api.delete(`/harvest-entries/${entryId}`),
    successMessage: "Entry deleted",
    invalidate: [["harvest-sessions"], ["harvests"]],
  });
}
