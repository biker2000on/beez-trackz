"use client";

/** React Query hooks for equipment types, stock, ledger actions, and losses. */

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
  LossReport,
  PhysicalCountResult,
  StockAdjustment,
  StockStateChange,
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

export function useStockStateChanges(stockId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["equipment", "state-changes", stockId],
    queryFn: () =>
      api.get<StockStateChange[]>(`/equipment/stock/${stockId}/state-changes`),
    enabled,
  });
}

export function useLossReport(range: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ["equipment", "loss-report", range.from ?? "", range.to ?? ""],
    queryFn: () =>
      api.get<LossReport>("/equipment/loss-report", {
        params: { from: range.from || undefined, to: range.to || undefined },
      }),
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
  successMessage: string | ((data: TData) => string);
  invalidate?: QueryKey[];
  /** Set when the caller renders its own error UI (e.g. per-line errors). */
  silentError?: boolean;
}

function useEquipmentMutation<TVars, TData = unknown>(
  options: EquipmentMutationOptions<TVars, TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: options.mutationFn,
    onSuccess: (data) => {
      toast.success(
        typeof options.successMessage === "function"
          ? options.successMessage(data)
          : options.successMessage,
      );
      queryClient.invalidateQueries({ queryKey: ["equipment"] });
      for (const key of options.invalidate ?? []) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (error) => {
      if (options.silentError) return;
      toast.error(error instanceof Error ? error.message : "Request failed");
    },
  });
}

// --- deployments ---

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

export interface ReturnDeploymentBody {
  deploymentId: string;
  /** Omit to return everything still out. */
  quantity?: number;
  reason: string;
  condition: string;
  notes?: string;
  date?: string;
}

export function useReturnDeployment() {
  return useEquipmentMutation({
    mutationFn: ({ deploymentId, ...body }: ReturnDeploymentBody) =>
      api.post<{ quantityReturned: number; outstanding: number }>(
        `/equipment/deployments/${deploymentId}/return`,
        body,
      ),
    successMessage: (data) =>
      data.outstanding > 0
        ? `Returned ${data.quantityReturned} — ${data.outstanding} still on the hive`
        : "Returned to storage",
    invalidate: [["hives"]],
  });
}

/** Return everything still out on a deployment, with no extra detail. */
export function useRemoveDeployment() {
  return useEquipmentMutation({
    mutationFn: (id: string) =>
      api.post(`/equipment/deployments/${id}/return`, {
        reason: "season_end",
        condition: "good",
      }),
    successMessage: "Returned to storage",
    invalidate: [["hives"]],
  });
}

// --- ledger actions ---

export interface ReceiveStockBody {
  stockId: string;
  quantity: number;
  reason: string;
  unitCostCents?: number | null;
  date?: string;
  notes?: string;
}

export function useReceiveStock() {
  return useEquipmentMutation({
    mutationFn: ({ stockId, ...body }: ReceiveStockBody) =>
      api.post(`/equipment/stock/${stockId}/receive`, body),
    successMessage: "Stock received",
  });
}

export interface AdjustStockBody {
  stockId: string;
  quantity: number;
  reason: string;
  from?: "serviceable" | "damaged" | "retired";
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

export interface StateChangeBody {
  stockId: string;
  quantity: number;
  reason: string;
  from?: "serviceable" | "damaged" | "retired";
  date?: string;
  notes?: string;
}

export function useMarkDamaged() {
  return useEquipmentMutation({
    mutationFn: ({ stockId, ...body }: StateChangeBody) =>
      api.post(`/equipment/stock/${stockId}/damage`, body),
    successMessage: "Marked damaged",
  });
}

export function useRepairStock() {
  return useEquipmentMutation({
    mutationFn: ({ stockId, ...body }: StateChangeBody) =>
      api.post(`/equipment/stock/${stockId}/repair`, body),
    successMessage: "Back in service",
  });
}

export function useRetireStock() {
  return useEquipmentMutation({
    mutationFn: ({ stockId, ...body }: StateChangeBody) =>
      api.post(`/equipment/stock/${stockId}/retire`, body),
    successMessage: "Retired from service",
  });
}

// --- physical count ---

export interface PhysicalCountBody {
  date?: string;
  notes?: string;
  lines: { stockId: string; countedQuantity: number }[];
}

/**
 * Submit counted shelf quantities. The server works out the signed deltas and
 * records them as 'physical_count'; if any line cannot be resolved the whole
 * count is rejected with per-line errors, which the caller renders inline.
 */
export function usePhysicalCount() {
  return useEquipmentMutation({
    mutationFn: (body: PhysicalCountBody) =>
      api.post<PhysicalCountResult>("/equipment/physical-count", body),
    successMessage: (data) =>
      data.adjusted === 0
        ? `Counted ${data.counted} — everything already matched`
        : `Counted ${data.counted} · ${data.adjusted} corrected`,
    silentError: true,
  });
}

// --- stock rows ---

export interface UpdateStockBody {
  stockId: string;
  storageLocation?: string | null;
  notes?: string | null;
  neededQuantity?: number;
  unitCostCents?: number | null;
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
  neededQuantity?: number;
  unitCostCents?: number | null;
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
