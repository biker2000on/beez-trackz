"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";
import { formatFeeding, type UnitsSystem } from "@/lib/units";

// --- types + enums (mirror backend/internal/httpapi/routes_feedings.go) ---

export const FEEDING_TYPES = [
  ["sugar_syrup_1to1", "1:1 sugar syrup"],
  ["sugar_syrup_2to1", "2:1 sugar syrup"],
  ["dry_sugar", "Dry sugar"],
  ["pollen_patty", "Pollen patty"],
  ["fondant", "Fondant"],
  ["other", "Other"],
] as const;

export const FEEDER_TYPES = [
  ["entrance", "Entrance feeder"],
  ["top", "Top feeder"],
  ["frame", "Frame feeder"],
  ["baggie", "Baggie feeder"],
  ["bucket", "Bucket feeder"],
  ["open", "Open feeding"],
  ["other", "Other"],
] as const;

export const QUANTITY_UNITS = ["lbs", "oz", "quarts", "gallons"] as const;

export function feedingTypeLabel(type: string): string {
  return FEEDING_TYPES.find(([value]) => value === type)?.[1] ?? type;
}

export function feederTypeLabel(type: string | null): string | null {
  if (!type) return null;
  return FEEDER_TYPES.find(([value]) => value === type)?.[1] ?? type;
}

/** Preferred-system display for a stored feeding quantity. */
export function formatFeedingAmount(
  quantity: number,
  unit: string,
  units: UnitsSystem,
): string {
  return formatFeeding(quantity, unit, units)?.text ?? `${quantity} ${unit}`;
}

/**
 * Explicit feeder lifecycle (migration 00007_feeding_lifecycle):
 * - `open`       a feeder is on the hive right now
 * - `closed`     the feeder episode ended
 * - `unverified` a legacy record with no recorded end; not an active feeder,
 *                and the beekeeper is asked to verify it in the field
 */
export const FEEDING_STATUSES = ["open", "closed", "unverified"] as const;
export type FeedingStatus = (typeof FEEDING_STATUSES)[number];

export const FEEDING_CLOSE_REASONS = [
  ["emptied", "Feeder was empty"],
  ["removed", "Feeder taken off the hive"],
  ["verified_closed", "Checked — no feeder on the hive"],
  ["not_installed", "No feeder was ever left"],
] as const;

export interface Feeding {
  id: string;
  hiveId: string;
  dateFed: string;
  type: string;
  quantity: number;
  quantityUnit: string;
  feederType: string | null;
  dateEmpty: string | null;
  notes: string | null;
  createdAt: string;
  status: FeedingStatus;
  closedAt: string | null;
  closedReason: string | null;
  refillOfId: string | null;
}

/** One dashboard row per hive — see GET /feedings/status. */
export interface FeedingStatusRow {
  hiveId: string;
  hiveName: string;
  apiaryId: string;
  apiaryName: string;
  openFeeders: number;
  unverifiedFeeders: number;
  oldestOpenAt: string | null;
  oldestUnverifiedAt: string | null;
  openFeederAgeDays: number | null;
  unverifiedAgeDays: number | null;
  latestFeedAt: string | null;
  latestFeedType: string | null;
  latestQuantity: number | null;
  latestQuantityUnit: string | null;
  latestFeederType: string | null;
  daysSinceLastFeed: number | null;
  /** Sort/severity key: urgent first. */
  state: "attention" | "stale" | "ok";
  /** The observation behind the state, written for the beekeeper. */
  evidence: string;
  /** The field action to take; empty when nothing is needed. */
  action: string;
  actionFeedingId: string | null;
  latestFeedingId: string | null;
}

export interface ActiveFeeding {
  id: string;
  hiveId: string;
  dateFed: string;
  type: string;
  quantity: number;
  quantityUnit: string;
  feederType: string | null;
  hiveName: string;
  apiaryName: string;
}

export interface FeedingPayload {
  dateFed: string;
  type: string;
  quantity: number;
  quantityUnit: string;
  feederType?: string | null;
  notes?: string | null;
}

// --- queries ---

export function useHiveFeedings(hiveId: string) {
  return useQuery({
    queryKey: ["hives", "detail", hiveId, "feedings"],
    queryFn: () => api.get<Feeding[]>(`/hives/${hiveId}/feedings`),
  });
}

export function useActiveFeedings() {
  return useQuery({
    queryKey: ["feedings", "active"],
    queryFn: () => api.get<ActiveFeeding[]>("/feedings/active"),
  });
}

/** One row per hive, already sorted urgent-first by the API. */
export function useFeedingStatus() {
  return useQuery({
    queryKey: ["feedings", "status"],
    queryFn: () => api.get<FeedingStatusRow[]>("/feedings/status"),
  });
}

// --- mutations ---

function useInvalidateFeedings() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["hives"] });
    void queryClient.invalidateQueries({ queryKey: ["feedings"] });
  };
}

export function useCreateFeeding() {
  const invalidate = useInvalidateFeedings();
  return useMutation({
    mutationFn: (payload: FeedingPayload & { hiveId: string }) =>
      api.post<Feeding>("/feedings", payload),
    onSuccess: invalidate,
  });
}

export function useBulkFeedings() {
  const invalidate = useInvalidateFeedings();
  return useMutation({
    mutationFn: (payload: FeedingPayload & { hiveIds: string[] }) =>
      api.post<{ success: boolean; count: number }>("/feedings/bulk", payload),
    onSuccess: invalidate,
  });
}

export function useMarkFeedingEmpty() {
  const invalidate = useInvalidateFeedings();
  return useMutation({
    mutationFn: (id: string) => api.post<Feeding>(`/feedings/${id}/empty`),
    onSuccess: invalidate,
  });
}

/**
 * Close a feeder explicitly. The API rejects closing an already-closed
 * feeding, which is what keeps duplicate status rows from coming back.
 */
export function useCloseFeeding() {
  const invalidate = useInvalidateFeedings();
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: {
      id: string;
      reason?: string;
      dateEmpty?: string;
      notes?: string;
    }) => api.post<Feeding>(`/feedings/${id}/close`, payload),
    onSuccess: invalidate,
  });
}

/**
 * Refill a feeder: closes the record being topped up and opens exactly one
 * linked successor, so the hive keeps a single active feeder row.
 */
export function useRefillFeeding() {
  const invalidate = useInvalidateFeedings();
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: {
      id: string;
      dateFed?: string;
      type?: string;
      quantity?: number;
      quantityUnit?: string;
      feederType?: string | null;
      notes?: string;
    }) => api.post<Feeding>(`/feedings/${id}/refill`, payload),
    onSuccess: invalidate,
  });
}

export function useDeleteFeeding() {
  const invalidate = useInvalidateFeedings();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ success: boolean }>(`/feedings/${id}`),
    onSuccess: invalidate,
  });
}
