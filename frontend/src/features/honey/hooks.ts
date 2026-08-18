"use client";

/** React Query hooks for the honey ledger, harvests, and harvest sessions. */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { toast } from "sonner";

import { api, OfflineQueuedError } from "@/lib/api";
import type {
  ApiaryOption,
  HarvestRow,
  HarvestSessionDetail,
  HarvestSessionRow,
  HiveOption,
  HoneyInventoryRow,
  HoneyOverview,
  HoneySale,
  ProductBatch,
  ProductCatalogResponse,
  PropolisHarvest,
  SaleLineKind,
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

export function useHoneySales(enabled = true) {
  return useQuery({
    queryKey: ["honey", "sales"],
    queryFn: () => api.get<HoneySale[]>("/sales"),
    enabled,
  });
}

export function useSaleLocations() {
  return useQuery({
    queryKey: ["honey", "sale-locations"],
    queryFn: () => api.get<string[]>("/sales/locations"),
  });
}

export function useHarvests() {
  return useQuery({
    queryKey: ["harvests"],
    queryFn: () => api.get<HarvestRow[]>("/harvests"),
  });
}

export function useHarvestSessions(enabled = true) {
  return useQuery({
    queryKey: ["harvest-sessions"],
    queryFn: () => api.get<HarvestSessionRow[]>("/harvest-sessions"),
    enabled,
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

export function useProductCatalog(inStock = false) {
  return useQuery({
    queryKey: ["products", { inStock }],
    queryFn: () =>
      api.get<ProductCatalogResponse>("/products", {
        params: inStock ? { inStock: "1" } : undefined,
      }),
  });
}

export function usePropolisHarvests() {
  return useQuery({
    queryKey: ["propolis-harvests"],
    queryFn: () => api.get<PropolisHarvest[]>("/propolis-harvests"),
  });
}

export function useProductBatches() {
  return useQuery({
    queryKey: ["product-batches"],
    queryFn: () => api.get<ProductBatch[]>("/product-batches"),
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
      if (error instanceof OfflineQueuedError) {
        toast.info("Saved offline — will sync when you reconnect");
        return;
      }
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

export interface SaleLineBody {
  kind: SaleLineKind;
  jarSizeId?: string;
  hiveId?: string;
  equipmentStockId?: string;
  productId?: string;
  quantity: number;
  unitPrice: number;
}

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
  lines: SaleLineBody[];
  notes?: string;
}

export function useRecordSale() {
  // Errors (e.g. "Not enough Pint: need 4, have 2") surface inline in the
  // dialog instead of a toast.
  return useHoneyMutation({
    mutationFn: (body: SaleBody) => api.post("/sales", body),
    successMessage: "Sale recorded",
    silentError: true,
    invalidate: [["commerce"], ["hives"], ["equipment"], ["feedings"], ["products"]],
  });
}

export function useCreateProduct() {
  return useHoneyMutation({
    mutationFn: (body: {
      name: string;
      kind: string;
      unit: string;
      defaultPrice: number;
      sizeLabel?: string;
    }) => api.post("/products", body),
    successMessage: "Product saved",
    invalidate: [["products"]],
  });
}

export function useCreatePropolisHarvest() {
  return useHoneyMutation({
    mutationFn: (body: {
      hiveId?: string;
      apiaryId?: string;
      date: string;
      amount: number;
      unit: "grams" | "ounces";
      notes?: string;
    }) => api.post("/propolis-harvests", body),
    successMessage: "Propolis harvest recorded",
    invalidate: [["propolis-harvests"], ["products"]],
  });
}

export function useCreateProductBatch() {
  return useHoneyMutation({
    mutationFn: (body: {
      kind: string;
      productId: string;
      harvestLotId?: string;
      startedAt: string;
      finishedAt?: string;
      honeyLbs?: number;
      waterLiters?: number;
      yeast?: string;
      vessel?: string;
      propolisHarvestId?: string;
      propolisAmount?: number;
      propolisUnit?: "grams" | "ounces";
      quantityOut: number;
      notes?: string;
      expenseIds?: string[];
    }) => api.post("/product-batches", body),
    successMessage: "Batch recorded",
    invalidate: [["product-batches"], ["products"], ["honey"], ["propolis-harvests"]],
  });
}

export interface HiveSaleOffer {
  hiveId: string;
  hiveLabel: string;
  apiaryName: string;
  status: string;
  sellable: boolean;
  reason: string;
  openFeeders: number;
  deployments: {
    id: string;
    stockId: string;
    typeName: string;
    typeCategory: string;
    outstanding: number;
    unitCostCents: number | null;
  }[];
}

export function useHiveSaleOffer(hiveId: string | null) {
  return useQuery({
    queryKey: ["hives", hiveId, "sale-offer"],
    queryFn: () => api.get<HiveSaleOffer>(`/hives/${hiveId}/sale-offer`),
    enabled: hiveId != null && hiveId !== "",
  });
}

export function useDeleteSale() {
  return useHoneyMutation({
    mutationFn: (id: string) => api.delete(`/sales/${id}`),
    successMessage: "Sale cancelled",
    invalidate: [["commerce"], ["hives"], ["equipment"], ["feedings"], ["products"]],
  });
}

export function useUpdateSale() {
  return useHoneyMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      orderStatus: "draft" | "pending" | "paid" | "fulfilled";
      amountPaid?: number;
      paymentMethod?: "cash" | "card" | "check" | "venmo" | "paypal" | "invoice" | "other";
      dueDate?: string;
    }) => api.patch(`/sales/${id}`, body),
    successMessage: "Order updated",
    invalidate: [["commerce"]],
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
            ? api.delete(`/sales/${entry.id}`)
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
  moisturePct?: number;
}

export function useUpdateSession(sessionId: string) {
  return useHoneyMutation({
    mutationFn: (body: { moisturePct?: number; notes?: string }) =>
      api.patch(`/harvest-sessions/${sessionId}`, body),
    successMessage: "Session updated",
    invalidate: [["harvest-sessions"]],
  });
}

export function useCreateSession() {
  return useHoneyMutation<SessionBody, { id: string }>({
    mutationFn: (body) => api.post<{ id: string }>("/harvest-sessions", body),
    successMessage: "Session created",
    invalidate: [["harvest-sessions"]],
  });
}

/** One harvest measurement: a super-weight pair or a direct harvested weight. */
export interface HarvestMeasurement {
  superWeightBefore?: number;
  superWeightAfter?: number;
  harvestedWeight?: number;
  notes?: string;
}

export interface HarvestBody extends HarvestMeasurement {
  hiveId: string;
  date: string;
}

export function useCreateHarvest() {
  return useHoneyMutation({
    mutationFn: (body: HarvestBody) => api.post("/harvests", body),
    successMessage: "Harvest recorded",
    invalidate: [["harvests"], ["harvest-sessions"]],
  });
}

export interface SessionEntryBody extends HarvestMeasurement {
  hiveId: string;
}

/** Saves a whole walkthrough of hive entries in one transaction. */
export function useAddSessionEntries(sessionId: string) {
  return useHoneyMutation({
    mutationFn: (entries: SessionEntryBody[]) =>
      api.post<{ count: number }>(`/harvest-sessions/${sessionId}/entries`, {
        entries,
      }),
    successMessage: "Entries saved",
    invalidate: [["harvest-sessions"], ["harvests"]],
  });
}

export function useTrueUpSession(sessionId: string) {
  return useHoneyMutation({
    mutationFn: (body: { totalExtractedWeight: number; reason?: string }) =>
      api.post(`/harvest-sessions/${sessionId}/true-up`, body),
    successMessage: "Extracted weight saved",
    invalidate: [["harvest-sessions"]],
  });
}

export function useDeleteSessionEntry() {
  return useHoneyMutation({
    mutationFn: ({ entryId, reason }: { entryId: string; reason?: string }) =>
      api.delete(
        `/harvest-entries/${entryId}`,
        reason ? { reason } : undefined,
      ),
    successMessage: "Entry removed",
    invalidate: [["harvest-sessions"], ["harvests"]],
  });
}
