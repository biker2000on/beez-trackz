"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";

export interface HarvestLot {
  id: string;
  lotCode: string;
  publicSlug: string;
  extractionDate: string;
  honeyWeightLbs: number;
  honeyWeightEntered: string | null;
  /**
   * Where honeyWeightLbs came from. 'derived' means it is the sum of the
   * linked harvests and is recomputed whenever that set changes; 'manual'
   * means the operator typed it and it is left alone.
   */
  honeyWeightSource: "manual" | "derived";
  /** What the linked harvests sum to, reported on manual lots too. */
  derivedWeightLbs: number;
  linkedHarvestCount: number;
  honeyVariety: string | null;
  claimSpecies: string | null;
  claimYear: number | null;
  claimApiaryId: string | null;
  claimApiaryName: string | null;
  claimElevationM: number | null;
  floralClaim: string;
  season: string | null;
  apiaryRegion: string | null;
  bloomNotes: string | null;
  beekeeperStory: string | null;
  testingData: Record<string, unknown>;
  reorderUrl: string | null;
  isPublic: boolean;
  moisturePct: number | null;
  bottlingMoisturePct: number | null;
  /** Read-only record of an accepted over-threshold moisture reading. */
  moistureOverrideReason: string | null;
  moistureOverrideAt: string | null;
  lockout?: {
    locked: boolean;
    treatmentOn: boolean;
    lockoutUntil: string | null;
    product: string | null;
    dateApplied: string | null;
    dateRemoved: string | null;
    withdrawalDays: number;
    message: string;
  } | null;
  sourceHarvestIds: string[];
  sourceApiaries: string[];
  photos: { id: string; url: string; caption: string | null }[];
  bottlingRuns: {
    id: string;
    bottledDate: string;
    jarSizeId: string | null;
    jarSizeLabel: string | null;
    quantity: number;
    honeyLbs: number | null;
    notes: string | null;
    serialCount: number;
  }[];
  createdAt: string;
  updatedAt: string;
}

export interface HarvestLotInput {
  lotCode: string;
  publicSlug?: string;
  extractionDate: string;
  /** Omitted when the weight is derived from the linked harvests. */
  honeyWeightLbs?: number;
  honeyWeightSource?: "manual" | "derived";
  honeyWeightEntered?: string;
  honeyVariety?: string;
  claimSpecies?: string;
  claimYear?: number;
  claimApiaryId?: string;
  claimElevationM?: number;
  season?: string;
  apiaryRegion?: string;
  bloomNotes?: string;
  beekeeperStory?: string;
  testingData?: Record<string, unknown>;
  reorderUrl?: string;
  isPublic: boolean;
  harvestIds: string[];
  photoIds: string[];
  moisturePct?: number | null;
  bottlingMoisturePct?: number | null;
  /** Accept an over-threshold extraction reading; requires a reason. */
  moistureOverride?: boolean;
  moistureOverrideReason?: string;
}

export interface Expense {
  id: string;
  expenseDate: string;
  category: string;
  description: string;
  amount: number;
  apiaryId: string | null;
  apiaryName: string | null;
  hiveId: string | null;
  hiveName: string | null;
  harvestLotId: string | null;
  lotCode: string | null;
  season: string | null;
  vendor: string | null;
  quantity: number | null;
  unit: string | null;
  notes: string | null;
}

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  emailOptIn: boolean;
  referralCode: string | null;
  referredBy: string | null;
  orderCount: number;
  lifetimeRevenue: number;
  lastOrderDate: string | null;
  reorderReminderDue: boolean;
}

export interface Profitability {
  year: number;
  revenue: number;
  expenses: number;
  grossMargin: number;
  marginPercent: number;
  harvestedPounds: number;
  costPerHarvestedPound: number;
  costPerJarSold: number;
  inventoryValue: number;
  jarsSold: number;
  breakEvenByJarSize: {
    jarSizeId: string;
    label: string;
    breakEvenPrice: number;
    defaultPrice: number | null;
    onHand: number;
  }[];
  byChannel: { channel: string; revenue: number; orderCount: number }[];
  byJarSize: {
    jarSizeId: string;
    label: string;
    jarsSold: number;
    revenue: number;
    estimatedHoneyCost: number;
    estimatedMargin: number;
  }[];
  byHarvestLot: {
    harvestLotId: string;
    lotCode: string;
    season: string | null;
    harvestedPounds: number;
    revenue: number;
    expenses: number;
    margin: number;
  }[];
  bySeason: {
    season: string;
    harvestedPounds: number;
    revenue: number;
    expenses: number;
    margin: number;
  }[];
  byKind?: { kind: string; revenue: number }[];
}

export interface ProductionPlan {
  lookbackDays: number;
  horizonDays: number;
  honeyRequiredLbs: number;
  projectedRevenue: number;
  bulkOnHandLbs: number;
  bulkReservedForWholesaleLbs: number;
  bulkAvailableAfterPlanLbs: number;
  releaseAlertSubscribers: number;
  recommendations: {
    jarSizeId: string;
    label: string;
    onHand: number;
    soldInLookback: number;
    projectedDemand: number;
    recommendedToBottle: number;
    packagingRequired: number;
    honeyRequiredLbs: number;
    projectedRevenue: number;
  }[];
}

export interface Reconciliation {
  date: string;
  orderCount: number;
  grossSales: number;
  amountCollected: number;
  balanceDue: number;
  breakdown: {
    paymentMethod: string;
    channel: string;
    orderCount: number;
    sales: number;
    paid: number;
    balanceDue: number;
  }[];
}

export interface WholesalePriceList {
  id: string;
  name: string;
  minimumOrderAmount: number;
  isActive: boolean;
  items: { jarSizeId: string; label: string; unitPrice: number }[];
}

function useCommerceMutation<TInput, TResult = unknown>(
  mutationFn: (input: TInput) => Promise<TResult>,
  success: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      toast.success(success);
      void client.invalidateQueries({ queryKey: ["commerce"] });
      void client.invalidateQueries({ queryKey: ["honey"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Request failed"),
  });
}

export function useHarvestLots(enabled = true) {
  return useQuery({
    queryKey: ["commerce", "harvest-lots"],
    queryFn: () => api.get<HarvestLot[]>("/harvest-lots"),
    enabled,
  });
}

export function useCreateHarvestLot() {
  return useCommerceMutation(
    (body: HarvestLotInput) =>
      api.post<{ id: string; publicSlug: string; storyUrl: string }>("/harvest-lots", body),
    "Harvest lot created",
  );
}

export function useUpdateHarvestLot() {
  return useCommerceMutation(
    ({ id, ...body }: HarvestLotInput & { id: string }) =>
      api.patch(`/harvest-lots/${id}`, body),
    "Harvest lot updated",
  );
}

export function useCreateBottlingRun(lotId: string) {
  return useCommerceMutation(
    (body: {
      bottledDate: string;
      jarSizeId?: string;
      quantity: number;
      honeyLbs?: number;
      notes?: string;
      serialize: boolean;
      moisturePct?: number;
    }) => api.post(`/harvest-lots/${lotId}/bottling-runs`, body),
    "Bottling run recorded",
  );
}

export function useExpenses(year?: number) {
  return useQuery({
    queryKey: ["commerce", "expenses", year],
    queryFn: () => api.get<Expense[]>("/expenses", { params: { year } }),
  });
}

export function useCreateExpense() {
  return useCommerceMutation(
    (body: {
      expenseDate: string;
      category: string;
      description: string;
      amount: number;
      apiaryId?: string;
      hiveId?: string;
      harvestLotId?: string;
      season?: string;
      vendor?: string;
      quantity?: number;
      unit?: string;
      notes?: string;
    }) => api.post("/expenses", body),
    "Expense recorded",
  );
}

export function useDeleteExpense() {
  return useCommerceMutation(
    (id: string) => api.delete(`/expenses/${id}`),
    "Expense deleted",
  );
}

export function useCustomers() {
  return useQuery({
    queryKey: ["commerce", "customers"],
    queryFn: () => api.get<Customer[]>("/customers"),
  });
}

export function useCreateCustomer() {
  return useCommerceMutation(
    (body: {
      name: string;
      email?: string;
      phone?: string;
      notes?: string;
      emailOptIn: boolean;
      referredBy?: string;
    }) => api.post("/customers", body),
    "Customer saved",
  );
}

export function useUpdateCustomer() {
  return useCommerceMutation(
    ({
      id,
      ...body
    }: {
      id: string;
      name: string;
      email?: string | null;
      phone?: string | null;
      notes?: string | null;
      emailOptIn: boolean;
      referralCode?: string | null;
      referredBy?: string | null;
    }) => api.patch(`/customers/${id}`, body),
    "Customer updated",
  );
}

export function useProfitability(year: number) {
  return useQuery({
    queryKey: ["commerce", "profitability", year],
    queryFn: () =>
      api.get<Profitability>("/analytics/profitability", {
        params: { year },
      }),
  });
}

export function useProductionPlan(days = 90, horizon = 30) {
  return useQuery({
    queryKey: ["commerce", "production-plan", days, horizon],
    queryFn: () =>
      api.get<ProductionPlan>("/honey/production-plan", {
        params: { days, horizon },
      }),
  });
}

export function useReconciliation(date: string) {
  return useQuery({
    queryKey: ["commerce", "reconciliation", date],
    queryFn: () =>
      api.get<Reconciliation>("/market-day/reconciliation", {
        params: { date },
      }),
  });
}

export function useLowStock() {
  return useQuery({
    queryKey: ["commerce", "low-stock"],
    queryFn: () =>
      api.get<{ jarSizeId: string; label: string; onHand: number; threshold: number }[]>(
        "/honey/low-stock",
      ),
  });
}

export function useWholesalePriceLists() {
  return useQuery({
    queryKey: ["commerce", "wholesale-price-lists"],
    queryFn: () => api.get<WholesalePriceList[]>("/wholesale-price-lists"),
  });
}

export function useCreateWholesalePriceList() {
  return useCommerceMutation(
    (body: {
      name: string;
      minimumOrderAmount: number;
      items: { jarSizeId: string; unitPrice: number }[];
    }) => api.post("/wholesale-price-lists", body),
    "Wholesale price list created",
  );
}

/* ---------------------------------------------------------------------------
 * Serialized jar traceability
 *
 * A serial printed on a jar lid is the only thing someone holding the jar has,
 * so it is the lookup key for the whole chain: serial -> bottling run -> lot ->
 * sale. `sale` is null until the jar is linked to an order.
 * ------------------------------------------------------------------------- */

export interface JarSerialTrace {
  serialNumber: string;
  createdAt: string;
  bottlingRun: {
    id: string;
    bottledDate: string;
    jarSizeLabel: string | null;
    quantity: number;
  };
  harvestLot: {
    id: string;
    lotCode: string;
    variety: string | null;
    season: string | null;
    publicSlug: string;
  };
  sale: {
    id: string;
    date: string;
    customerName: string | null;
    orderStatus: string;
    soldAt: string | null;
    linkedByName: string | null;
  } | null;
}

export interface SaleJarSerial {
  serialNumber: string;
  lotCode: string;
  jarSizeLabel: string | null;
  soldAt: string | null;
}

/**
 * Look up one serial. Disabled until a serial is supplied, and never retried:
 * an unknown serial is a 404 the operator needs to see immediately, not after
 * three silent attempts.
 */
export function useJarSerialLookup(serialNumber: string) {
  const trimmed = serialNumber.trim();
  return useQuery({
    queryKey: ["commerce", "jar-serial", trimmed.toLowerCase()],
    queryFn: () =>
      api.get<JarSerialTrace>(`/honey/serials/${encodeURIComponent(trimmed)}`),
    enabled: trimmed.length > 0,
    retry: false,
  });
}

export function useSaleSerials(saleId: string) {
  return useQuery({
    queryKey: ["commerce", "sale-serials", saleId],
    queryFn: () => api.get<SaleJarSerial[]>(`/sales/${saleId}/serials`),
  });
}

export function useLinkSaleSerials(saleId: string) {
  return useCommerceMutation(
    (serialNumbers: string[]) =>
      api.post<SaleJarSerial[]>(`/sales/${saleId}/serials`, { serialNumbers }),
    "Jar serials linked",
  );
}

export function useUnlinkSaleSerial(saleId: string) {
  return useCommerceMutation(
    (serialNumber: string) =>
      api.delete(`/sales/${saleId}/serials/${encodeURIComponent(serialNumber)}`),
    "Jar serial unlinked",
  );
}
