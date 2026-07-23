"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";

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
    mutationFn: (id: string) =>
      api.post<{ success: boolean }>(`/feedings/${id}/empty`),
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
