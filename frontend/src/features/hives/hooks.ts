"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";

// --- types (mirror backend/internal/httpapi/routes_hives.go et al.) ---

export interface HiveLockout {
  locked: boolean;
  treatmentOn: boolean;
  lockoutUntil: string | null;
  product: string | null;
  dateApplied: string | null;
  dateRemoved: string | null;
  withdrawalDays: number;
  message: string;
  /** Treatment driving the lockout, for ending it from the UI. */
  treatmentEventId?: string | null;
}

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
  latitude?: number | null;
  longitude?: number | null;
  saleId?: string | null;
  createdAt: string;
  updatedAt: string;
  lockout?: HiveLockout | null;
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

export interface HiveReadiness {
  hiveId: string;
  hiveName: string;
  apiaryId: string;
  apiaryName: string;
  call: "will_swarm" | "ready_to_split" | "neither";
  evidence: string[];
  daysSinceLastSplit: number | null;
}

export interface DeadoutAutopsyPayload {
  autopsyDate: string;
  storesLeft?: string | null;
  clusterPosition?: string | null;
  lastFallMiteLoad?: number | null;
  queenStatus?: "present" | "absent" | "unknown" | null;
  moisture?: boolean | null;
  mold?: boolean | null;
  notes?: string | null;
}

export interface CatchBox {
  id: string;
  apiaryId: string;
  apiaryName: string;
  locationKind: "yard" | "stand" | "fence_line";
  standId: string | null;
  fenceLine: string | null;
  dateSet: string;
  emptyAsOf: string | null;
  occupied: boolean;
  occupiedAt: string | null;
  occupiedHiveId: string | null;
  notes: string | null;
}

// --- queries ---

export function useHives(filters: HiveListFilters = {}, enabled = true) {
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
    enabled,
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

export function useHiveReadiness() {
  return useQuery({
    queryKey: ["hives", "readiness"],
    queryFn: () => api.get<HiveReadiness[]>("/field/readiness"),
  });
}

export function useCatchBoxes() {
  return useQuery({
    queryKey: ["hives", "catch-boxes"],
    queryFn: () => api.get<CatchBox[]>("/catch-boxes"),
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

export function useUpdateHiveGps(id: string) {
  const invalidate = useInvalidateHives();
  return useMutation({
    mutationFn: (payload: {
      latitude: number | null;
      longitude: number | null;
    }) => api.patch<Hive>(`/hives/${id}/gps`, payload),
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

export function useSaveDeadoutAutopsy() {
  const invalidate = useInvalidateHives();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ hiveId, ...payload }: DeadoutAutopsyPayload & { hiveId: string }) =>
      api.put<{ success: boolean; id: string }>(`/hives/${hiveId}/autopsy`, payload),
    onSuccess: () => {
      invalidate();
      // The autopsy feeds the deadout-segment and winter-survival reports.
      void client.invalidateQueries({ queryKey: ["analytics"] });
    },
  });
}

export function useCreateColonyIntake() {
  const invalidate = useInvalidateHives();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      apiaryId: string;
      positionLabel: string;
      source: "package" | "nuc" | "split" | "swarm" | "catch_box" | "other";
      sourceDetail?: string;
      sourceHiveId?: string;
      catchBoxId?: string;
      intakeDate: string;
      startingStores?: string;
      cost: number;
      notes?: string;
    }) => api.post<{ id: string; hiveId: string }>("/colony-intakes", payload),
    onSuccess: () => {
      invalidate();
      // The intake also writes a queen row and a bees_queens expense.
      void client.invalidateQueries({ queryKey: ["queens"] });
      void client.invalidateQueries({ queryKey: ["commerce"] });
    },
  });
}

export function useCreateCatchBox() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      apiaryId: string;
      locationKind: CatchBox["locationKind"];
      standId?: string;
      fenceLine?: string;
      dateSet: string;
      emptyAsOf?: string;
      notes?: string;
    }) => api.post<{ id: string }>("/catch-boxes", payload),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["hives", "catch-boxes"] }),
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
