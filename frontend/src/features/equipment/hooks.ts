"use client";

/** React Query hooks for equipment types, stock, deployments, and frames. */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type {
  ActiveDeployment,
  EquipmentStockRow,
  EquipmentType,
  FrameSummary,
  HiveOption,
  StockAdjustment,
} from "./types";

// --- queries ---

export function useEquipmentTypes() {
  return useQuery({
    queryKey: ["equipment", "types"],
    queryFn: () => api.get<EquipmentType[]>("/equipment/types"),
  });
}

export function useEquipmentStock() {
  return useQuery({
    queryKey: ["equipment", "stock"],
    queryFn: () => api.get<EquipmentStockRow[]>("/equipment/stock"),
  });
}

export function useFrameSummary() {
  return useQuery({
    queryKey: ["equipment", "frame-summary"],
    queryFn: () => api.get<FrameSummary>("/equipment/frame-summary"),
  });
}

export function useActiveDeployments() {
  return useQuery({
    queryKey: ["equipment", "deployments", "active"],
    queryFn: () => api.get<ActiveDeployment[]>("/equipment/deployments/active"),
  });
}

export function useStockAdjustments(stockId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["equipment", "adjustments", stockId],
    queryFn: () =>
      api.get<StockAdjustment[]>(`/equipment/stock/${stockId}/adjustments`),
    enabled,
  });
}

export function useHiveOptions() {
  return useQuery({
    queryKey: ["hives", "options"],
    queryFn: () => api.get<HiveOption[]>("/hives"),
  });
}

// --- mutation helper ---

interface EquipmentMutationOptions<TVars, TData> {
  mutationFn: (vars: TVars) => Promise<TData>;
  successMessage: string;
  invalidate?: QueryKey[];
}

function useEquipmentMutation<TVars, TData = unknown>(
  options: EquipmentMutationOptions<TVars, TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: options.mutationFn,
    onSuccess: () => {
      toast.success(options.successMessage);
      queryClient.invalidateQueries({ queryKey: ["equipment"] });
      for (const key of options.invalidate ?? []) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Request failed");
    },
  });
}

// --- mutations ---

export interface DeployBody {
  stockId: string;
  hiveId: string;
  quantity: number;
  notes?: string;
}

export function useDeployEquipment() {
  return useEquipmentMutation({
    mutationFn: (body: DeployBody) => api.post("/equipment/deployments", body),
    successMessage: "Equipment deployed",
    // The hive detail Equipment tab caches deployments under the hives key.
    invalidate: [["hives"]],
  });
}

export function useRemoveDeployment() {
  return useEquipmentMutation({
    mutationFn: (id: string) => api.post(`/equipment/deployments/${id}/remove`),
    successMessage: "Returned to storage",
    invalidate: [["hives"]],
  });
}

export interface AdjustStockBody {
  stockId: string;
  quantity: number;
  reason: string;
  date?: string;
  notes?: string;
}

export function useAdjustStock() {
  return useEquipmentMutation({
    mutationFn: ({ stockId, ...body }: AdjustStockBody) =>
      api.post(`/equipment/stock/${stockId}/adjust`, body),
    successMessage: "Stock adjusted",
  });
}

export interface BulkAdjustBody {
  date?: string;
  reason?: string;
  lines: { stockId: string; newTotal: number }[];
}

export function useBulkAdjustStock() {
  return useEquipmentMutation({
    mutationFn: (body: BulkAdjustBody) =>
      api.post("/equipment/stock/bulk-adjust", body),
    successMessage: "Counts updated",
  });
}

export interface UpdateStockBody {
  stockId: string;
  storageLocation?: string | null;
  notes?: string | null;
}

export function useUpdateStock() {
  return useEquipmentMutation({
    mutationFn: ({ stockId, ...body }: UpdateStockBody) =>
      api.patch(`/equipment/stock/${stockId}`, body),
    successMessage: "Stock updated",
  });
}

export interface CreateStockBody {
  typeId: string;
  initialQuantity?: number;
  storageLocation?: string;
  notes?: string;
  frameCondition?: "drawn" | "fresh";
}

export function useCreateStock() {
  return useEquipmentMutation({
    mutationFn: (body: CreateStockBody) => api.post("/equipment/stock", body),
    successMessage: "Stock added",
  });
}

export interface CreateTypeBody {
  name: string;
  category: string;
  framesPerBox?: number;
}

export function useCreateType() {
  return useEquipmentMutation({
    mutationFn: (body: CreateTypeBody) => api.post("/equipment/types", body),
    successMessage: "Equipment type added",
  });
}

export function useSeedDefaultTypes() {
  return useEquipmentMutation({
    mutationFn: () => api.post("/equipment/seed-defaults", {}),
    successMessage: "Standard equipment types added",
  });
}
