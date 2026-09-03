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
import {
  ledgerItemId,
  type ActiveDeployment,
  type AssembleResult,
  type EquipmentComponentLine,
  type EquipmentStockRow,
  type EquipmentType,
  type FrameSummary,
  type HiveOption,
  type LossReport,
  type PhysicalCountLine,
  type PhysicalCountResult,
  type StockAdjustment,
  type StockStateChange,
} from "./types";

type WireItem = { itemId?: string; stockId?: string };

function withItemId<T extends WireItem>(row: T): T & { itemId: string } {
  return { ...row, itemId: ledgerItemId(row) };
}

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
    queryFn: async () => {
      const rows = await api.get<ActiveDeployment[]>(
        "/equipment/deployments/active",
      );
      return rows.map(withItemId);
    },
  });
}

export function useStockAdjustments(itemId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["equipment", "adjustments", itemId],
    queryFn: async () => {
      const rows = await api.get<StockAdjustment[]>(
        `/equipment/stock/${itemId}/adjustments`,
      );
      return rows.map(withItemId);
    },
    enabled,
  });
}

export function useStockStateChanges(itemId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["equipment", "state-changes", itemId],
    queryFn: async () => {
      const rows = await api.get<StockStateChange[]>(
        `/equipment/stock/${itemId}/state-changes`,
      );
      return rows.map(withItemId);
    },
    enabled,
  });
}

export function useLossReport(range: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ["equipment", "loss-report", range.from ?? "", range.to ?? ""],
    queryFn: async () => {
      const report = await api.get<LossReport>("/equipment/loss-report", {
        params: { from: range.from || undefined, to: range.to || undefined },
      });
      return {
        ...report,
        events: report.events.map(withItemId),
      };
    },
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
  itemId: string;
  hiveId: string;
  quantity: number;
  notes?: string;
}

export function useDeployEquipment() {
  return useEquipmentMutation({
    mutationFn: ({ itemId, ...body }: DeployBody) =>
      // Handlers still decode the item as stockId on POST /equipment/deployments.
      api.post("/equipment/deployments", { ...body, stockId: itemId }),
    successMessage: "Equipment deployed",
    // The hive detail Equipment tab caches deployments under the hives key.
    invalidate: [["hives"]],
  });
}

export interface ReturnDeploymentBody {
  /** Deploy inventory_operations.id (path /equipment/deployments/{id}). */
  operationId: string;
  /** Omit to return everything still out. */
  quantity?: number;
  reason: string;
  condition: string;
  notes?: string;
  date?: string;
}

export function useReturnDeployment() {
  return useEquipmentMutation({
    mutationFn: ({ operationId, ...body }: ReturnDeploymentBody) =>
      api.post<{
        id: string;
        quantityReturned: number;
        totalReturned: number;
        outstanding: number;
        fullyReturned: boolean;
        replayed?: boolean;
      }>(`/equipment/deployments/${operationId}/return`, body),
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
  itemId: string;
  quantity: number;
  reason: string;
  unitCostCents?: number | null;
  firstDeployedYear?: number | null;
  date?: string;
  notes?: string;
}

export function useReceiveStock() {
  return useEquipmentMutation({
    mutationFn: ({ itemId, ...body }: ReceiveStockBody) =>
      api.post(`/equipment/stock/${itemId}/receive`, body),
    successMessage: "Stock received",
  });
}

export interface AdjustStockBody {
  itemId: string;
  quantity: number;
  reason: string;
  from?: "serviceable" | "damaged" | "retired";
  date?: string;
  notes?: string;
}

export function useAdjustStock() {
  return useEquipmentMutation({
    mutationFn: ({ itemId, ...body }: AdjustStockBody) =>
      api.post(`/equipment/stock/${itemId}/adjust`, body),
    successMessage: "Stock adjusted",
  });
}

export interface StateChangeBody {
  itemId: string;
  quantity: number;
  reason: string;
  from?: "serviceable" | "damaged" | "retired";
  date?: string;
  notes?: string;
}

export function useMarkDamaged() {
  return useEquipmentMutation({
    mutationFn: ({ itemId, ...body }: StateChangeBody) =>
      api.post(`/equipment/stock/${itemId}/damage`, body),
    successMessage: "Marked damaged",
  });
}

export function useRepairStock() {
  return useEquipmentMutation({
    mutationFn: ({ itemId, ...body }: StateChangeBody) =>
      api.post(`/equipment/stock/${itemId}/repair`, body),
    successMessage: "Back in service",
  });
}

export function useRetireStock() {
  return useEquipmentMutation({
    mutationFn: ({ itemId, ...body }: StateChangeBody) =>
      api.post(`/equipment/stock/${itemId}/retire`, body),
    successMessage: "Retired from service",
  });
}

// --- physical count ---

export interface PhysicalCountBody {
  date?: string;
  notes?: string;
  lines: { itemId: string; countedQuantity: number }[];
}

/**
 * Submit counted shelf quantities. The server works out the signed deltas and
 * records them as 'physical_count'; if any line cannot be resolved the whole
 * count is rejected with per-line errors, which the caller renders inline.
 */
export function usePhysicalCount() {
  return useEquipmentMutation({
    mutationFn: async (body: PhysicalCountBody) => {
      const result = await api.post<PhysicalCountResult>(
        "/equipment/physical-count",
        {
          ...body,
          // Handlers still decode each counted line as stockId.
          lines: body.lines.map((line) => ({
            stockId: line.itemId,
            countedQuantity: line.countedQuantity,
          })),
        },
      );
      return {
        ...result,
        lines: (result.lines ?? []).map((line: PhysicalCountLine) =>
          withItemId(line),
        ),
      };
    },
    successMessage: (data) =>
      data.adjusted === 0
        ? `Counted ${data.counted} — everything already matched`
        : `Counted ${data.counted} · ${data.adjusted} corrected`,
    silentError: true,
  });
}

// --- stock rows ---

export interface UpdateStockBody {
  itemId: string;
  storageLocation?: string | null;
  notes?: string | null;
  neededQuantity?: number;
  unitCostCents?: number | null;
  firstDeployedYear?: number | null;
}

export function useUpdateStock() {
  return useEquipmentMutation({
    mutationFn: ({ itemId, ...body }: UpdateStockBody) =>
      api.patch(`/equipment/stock/${itemId}`, body),
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
  firstDeployedYear?: number | null;
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
  variantOfTypeId?: string;
}

export function useCreateType() {
  return useEquipmentMutation({
    mutationFn: (body: CreateTypeBody) => api.post("/equipment/types", body),
    successMessage: "Equipment type added",
  });
}

export interface UpdateTypeBody {
  typeId: string;
  name?: string;
  category?: string;
  framesPerBox?: number;
  clearFramesPerBox?: boolean;
  variantOfTypeId?: string;
  clearVariantOf?: boolean;
}

export function useUpdateType() {
  return useEquipmentMutation({
    mutationFn: ({ typeId, ...body }: UpdateTypeBody) =>
      api.patch(`/equipment/types/${typeId}`, body),
    successMessage: "Type updated",
  });
}

export function useDeleteType() {
  return useEquipmentMutation({
    mutationFn: (typeId: string) => api.delete(`/equipment/types/${typeId}`),
    successMessage: "Type deleted",
  });
}

// --- bill of materials ---

export function useEquipmentComponents() {
  return useQuery({
    queryKey: ["equipment", "components"],
    queryFn: () => api.get<EquipmentComponentLine[]>("/equipment/components"),
  });
}

export interface SetComponentsBody {
  typeId: string;
  components: { componentTypeId: string; quantity: number }[];
}

export function useSetComponents() {
  return useEquipmentMutation({
    mutationFn: ({ typeId, components }: SetComponentsBody) =>
      api.put(`/equipment/types/${typeId}/components`, { components }),
    successMessage: "Bill of materials saved",
  });
}

export interface AssembleBody {
  typeId: string;
  quantity: number;
  action: "assemble" | "disassemble";
  date?: string;
  notes?: string;
}

export function useAssemble() {
  return useEquipmentMutation({
    mutationFn: (body: AssembleBody) =>
      api.post<AssembleResult>("/equipment/assemblies", body),
    successMessage: (data) =>
      data.replayed
        ? "Already recorded"
        : data.action === "assemble"
          ? `Assembled ${data.quantity} × ${data.typeName}`
          : `Disassembled ${data.quantity} × ${data.typeName}`,
  });
}

export function useSeedDefaultTypes() {
  return useEquipmentMutation({
    mutationFn: () => api.post("/equipment/seed-defaults", {}),
    successMessage: "Standard equipment types added",
  });
}
