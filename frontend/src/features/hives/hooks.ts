"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";

// --- types (mirror backend/internal/httpapi/routes_hives.go et al.) ---

export interface Hive {
  id: string;
  apiaryId: string;
  apiaryName: string;
  positionLabel: string;
  standId: string | null;
  slotRow: number | null;
  slotCol: number | null;
  placement: string | null;
  facingDegrees: number | null;
  status: string;
  installedDate: string | null;
  isArchived: boolean;
  deadoutDate: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HivePayload {
  apiaryId?: string;
  positionLabel?: string | null;
  standId?: string | null;
  slotRow?: number | null;
  slotCol?: number | null;
  placement?: string | null;
  status?: string | null;
  installedDate?: string | null;
  notes?: string | null;
}

export interface HiveLocationEntry {
  id: string;
  apiaryId: string;
  apiaryName: string;
  positionLabel: string;
  dateFrom: string;
  dateTo: string | null;
}

export interface Queen {
  id: string;
  hiveId: string | null;
  origin: string;
  originHiveId: string | null;
  parentQueenId: string | null;
  introducedDate: string | null;
  status: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  hiveName: string | null;
  apiaryName: string | null;
}

export interface HiveSplit {
  id: string;
  parentHiveId: string;
  childHiveId: string;
  splitDate: string;
  splitType: string;
  framesMoved: number | null;
  notes: string | null;
  parentLabel: string;
  childLabel: string;
}

export interface HiveDeployment {
  id: string;
  stockId: string;
  quantity: number;
  /** Quantity still on the hive after partial returns. */
  outstanding?: number;
  quantityReturned?: number;
  dateDeployed: string;
  dateRemoved: string | null;
  notes: string | null;
  typeName: string;
  typeCategory: string;
}

export interface HiveListFilters {
  apiaryId?: string;
  status?: string;
  includeArchived?: boolean;
}

// --- queries ---

export function useHives(filters: HiveListFilters = {}) {
  return useQuery({
    queryKey: ["hives", "list", filters],
    queryFn: () =>
      api.get<Hive[]>("/hives", {
        params: {
          apiaryId: filters.apiaryId || undefined,
          status: filters.status || undefined,
          includeArchived: filters.includeArchived ? "true" : undefined,
        },
      }),
  });
}

export function useHive(id: string) {
  return useQuery({
    queryKey: ["hives", "detail", id],
    queryFn: () => api.get<Hive>(`/hives/${id}`),
  });
}

export function useHiveLocationHistory(id: string) {
  return useQuery({
    queryKey: ["hives", "detail", id, "location-history"],
    queryFn: () => api.get<HiveLocationEntry[]>(`/hives/${id}/location-history`),
  });
}

export function useHiveQueens(id: string) {
  return useQuery({
    queryKey: ["hives", "detail", id, "queens"],
    queryFn: () => api.get<Queen[]>(`/hives/${id}/queens`),
  });
}

export function useQueens() {
  return useQuery({
    queryKey: ["queens"],
    queryFn: () => api.get<Queen[]>("/queens"),
  });
}

export function useHiveSplits(id: string) {
  return useQuery({
    queryKey: ["hives", "detail", id, "splits"],
    queryFn: () => api.get<HiveSplit[]>(`/hives/${id}/splits`),
  });
}

export function useHiveDeployments(id: string) {
  return useQuery({
    queryKey: ["hives", "detail", id, "deployments"],
    queryFn: () => api.get<HiveDeployment[]>(`/hives/${id}/deployments`),
  });
}

// --- mutations ---

/** Invalidate everything hive-shaped plus apiary hive counts. */
function useInvalidateHives() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["hives"] });
    void queryClient.invalidateQueries({ queryKey: ["apiaries"] });
  };
}

export function useCreateHive() {
  const invalidate = useInvalidateHives();
  return useMutation({
    mutationFn: (payload: HivePayload) => api.post<Hive>("/hives", payload),
    onSuccess: invalidate,
  });
}

export function useUpdateHive(id: string) {
  const invalidate = useInvalidateHives();
  return useMutation({
    mutationFn: (payload: HivePayload) =>
      api.put<Hive>(`/hives/${id}`, payload),
    onSuccess: invalidate,
  });
}

export function useBulkCreateHives() {
  const invalidate = useInvalidateHives();
  return useMutation({
    mutationFn: (payload: {
      apiaryId: string;
      quantity: number;
      startLabel?: string;
    }) => api.post<{ success: boolean; count: number }>("/hives/bulk", payload),
    onSuccess: invalidate,
  });
}

export function useBulkUpdateHives() {
  const invalidate = useInvalidateHives();
  return useMutation({
    mutationFn: (payload: {
      hiveIds: string[];
      status?: string;
      isArchived?: boolean;
    }) =>
      api.patch<{ success: boolean; count: number }>("/hives/bulk", payload),
    onSuccess: invalidate,
  });
}

export function useArchiveHive() {
  const invalidate = useInvalidateHives();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ success: boolean }>(`/hives/${id}/archive`),
    onSuccess: invalidate,
  });
}

export function useUnarchiveHive() {
  const invalidate = useInvalidateHives();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ success: boolean }>(`/hives/${id}/unarchive`),
    onSuccess: invalidate,
  });
}

export function useDeadoutHive() {
  const invalidate = useInvalidateHives();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ success: boolean }>(`/hives/${id}/deadout`),
    onSuccess: invalidate,
  });
}

export function useCreateSplit() {
  const invalidate = useInvalidateHives();
  return useMutation({
    mutationFn: (payload: {
      parentHiveId: string;
      apiaryId: string;
      positionLabel: string;
      splitDate: string;
      splitType: string;
      framesMoved?: number | null;
      notes?: string | null;
    }) => api.post<{ success: boolean; id: string }>("/splits", payload),
    onSuccess: invalidate,
  });
}

export function useCreateQueen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      hiveId?: string | null;
      origin: string;
      originHiveId?: string | null;
      parentQueenId?: string | null;
      introducedDate?: string | null;
      status?: string | null;
      notes?: string | null;
    }) => api.post<Queen>("/queens", payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["queens"] });
      void queryClient.invalidateQueries({ queryKey: ["hives"] });
    },
  });
}

// Deploying lives in features/equipment (shared DeployDialog +
// useDeployEquipment); this module keeps only the hive-scoped reads and the
// full-return action.
export function useRemoveDeployment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deploymentId: string) =>
      api.post<{ success: boolean }>(
        `/equipment/deployments/${deploymentId}/remove`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["hives"] });
      void queryClient.invalidateQueries({ queryKey: ["equipment"] });
    },
  });
}
