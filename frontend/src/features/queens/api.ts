"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const QUEEN_ORIGINS = [
  "purchased",
  "swarm",
  "raised",
  "walked",
  "emergency_cell",
  "unknown",
] as const;

export const QUEEN_STATUSES = [
  "active",
  "superseded",
  "dead",
  "missing",
] as const;

export type QueenOrigin = (typeof QUEEN_ORIGINS)[number];
export type QueenStatus = (typeof QUEEN_STATUSES)[number];

export const QUEEN_ORIGIN_LABELS: Record<QueenOrigin, string> = {
  purchased: "Purchased",
  swarm: "Swarm",
  raised: "Raised",
  walked: "Walked",
  emergency_cell: "Emergency cell",
  unknown: "Unknown",
};

export const QUEEN_STATUS_LABELS: Record<QueenStatus, string> = {
  active: "Active",
  superseded: "Superseded",
  dead: "Dead",
  missing: "Missing",
};

/** Queen response shape from GET /queens. */
export interface Queen {
  id: string;
  hiveId: string | null;
  origin: QueenOrigin;
  originHiveId: string | null;
  parentQueenId: string | null;
  introducedDate: string | null;
  status: QueenStatus;
  notes: string | null;
  matedAtApiaryId: string | null;
  matedAtApiaryName: string | null;
  droneSourceNote: string | null;
  createdAt: string;
  updatedAt: string;
  hiveName: string | null;
  apiaryName: string | null;
}

/** Create/update request body for POST/PUT /queens. */
export interface QueenPayload {
  hiveId: string | null;
  origin: QueenOrigin;
  /** Not editable in the form, but PUT overwrites it — carry it through. */
  originHiveId: string | null;
  parentQueenId: string | null;
  introducedDate: string | null;
  status: QueenStatus;
  notes: string | null;
  matedAtApiaryId: string | null;
  droneSourceNote: string | null;
}

/** Subset of the hive shape needed for hive selects. */
export interface HiveOption {
  id: string;
  apiaryName: string;
  positionLabel: string;
  status: string;
}

export interface QueenPerformance {
  id: string;
  hiveId: string | null;
  hiveName: string | null;
  apiaryId: string | null;
  apiaryName: string | null;
  parentQueenId: string | null;
  introducedDate: string | null;
  status: QueenStatus;
  inspectionCount: number;
  broodScore: number;
  temperamentScore: number;
  yieldPounds: number;
  survivalScore: number;
  overallScore: number;
}

export interface QueenPerformanceResponse {
  weights: {
    brood: number;
    temperament: number;
    yield: number;
    survival: number;
  };
  queens: QueenPerformance[];
  lineages: Array<{
    queenId: string;
    queenCount: number;
    averageScore: number;
  }>;
}

export function useQueens() {
  return useQuery({
    queryKey: ["queens"],
    queryFn: () => api.get<Queen[]>("/queens"),
  });
}

export function useHiveOptions() {
  return useQuery({
    queryKey: ["hives", "options"],
    queryFn: () => api.get<HiveOption[]>("/hives"),
  });
}

export interface ApiaryOption {
  id: string;
  name: string;
}

export function useApiaryOptions() {
  return useQuery({
    queryKey: ["apiaries", "options"],
    queryFn: () => api.get<ApiaryOption[]>("/apiaries"),
  });
}

export function useQueenPerformance() {
  return useQuery({
    queryKey: ["queens", "performance"],
    queryFn: () =>
      api.get<QueenPerformanceResponse>("/analytics/queen-performance"),
  });
}

export function useCreateQueen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: QueenPayload) => api.post<Queen>("/queens", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["queens"] });
      queryClient.invalidateQueries({ queryKey: ["hives"] });
    },
  });
}

export function useUpdateQueen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...payload }: QueenPayload & { id: string }) =>
      api.put<Queen>(`/queens/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["queens"] });
      queryClient.invalidateQueries({ queryKey: ["hives"] });
    },
  });
}

export function useDeleteQueen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ success: boolean }>(`/queens/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["queens"] });
      queryClient.invalidateQueries({ queryKey: ["hives"] });
    },
  });
}

export function useBulkUpdateQueens() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      queens,
      status,
    }: {
      queens: Queen[];
      status: QueenStatus;
    }) => {
      const results = await Promise.allSettled(
        queens.map((queen) =>
          api.put<Queen>(`/queens/${queen.id}`, {
            hiveId: queen.hiveId,
            origin: queen.origin,
            originHiveId: queen.originHiveId,
            parentQueenId: queen.parentQueenId,
            introducedDate: queen.introducedDate,
            status,
            notes: queen.notes,
            matedAtApiaryId: queen.matedAtApiaryId,
            droneSourceNote: queen.droneSourceNote,
          } satisfies QueenPayload),
        ),
      );
      const failed = results.filter(
        (result) => result.status === "rejected",
      ).length;
      if (failed > 0) {
        throw new Error(`${failed} of ${queens.length} updates failed`);
      }
      return queens.length;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["queens"] });
      queryClient.invalidateQueries({ queryKey: ["hives"] });
    },
  });
}
