"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";

// --- types (mirror backend/internal/httpapi/routes_inspections.go) ---

export interface InspectionPest {
  type: string;
  /** Free-text count/severity ("12", "low", "heavy"). */
  count?: string | null;
}

export interface InspectionTreatment {
  product: string;
  method?: string | null;
}

export interface Inspection {
  id: string;
  hiveId: string;
  date: string;
  inspectorName: string | null;
  queenSeen: boolean | null;
  queenHealth: string | null;
  broodPattern: string | null;
  storesHoney: number | null;
  storesPollen: number | null;
  temperament: number | null;
  framesOfBees: number | null;
  framesOfBrood: number | null;
  framesOfStores: number | null;
  pests: InspectionPest[] | null;
  treatments: InspectionTreatment[] | null;
  notes: string | null;
  miteCounts?: {
    id: string;
    method: "alcohol_wash" | "sugar_roll" | "sticky_board" | "visual";
    mitesCount: number;
    sampleSize: number | null;
    daysOnBoard: number | null;
    mitesPer100: number | null;
    mitesPerDay: number | null;
    notes: string | null;
  }[];
  sourceMedia: unknown;
  weather: {
    source: string;
    fetchedAt: string;
    timezone: string;
    current: {
      time: string;
      temperature_2m: number;
      apparent_temperature: number;
      relative_humidity_2m: number;
      weather_code: number;
      wind_speed_10m: number;
    };
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecentInspection {
  id: string;
  hiveId: string;
  date: string;
  queenSeen: boolean | null;
  notes: string | null;
  hiveName: string;
  apiaryName: string;
}

export interface InspectionPayload {
  date: string;
  inspectorName?: string | null;
  queenSeen?: boolean | null;
  queenHealth?: string | null;
  broodPattern?: string | null;
  storesHoney?: number | null;
  storesPollen?: number | null;
  temperament?: number | null;
  framesOfBees?: number | null;
  framesOfBrood?: number | null;
  framesOfStores?: number | null;
  pests?: InspectionPest[] | null;
  treatments?: InspectionTreatment[] | null;
  miteCounts?: {
    method: "alcohol_wash" | "sugar_roll" | "sticky_board" | "visual";
    mitesCount: number;
    sampleSize?: number;
    daysOnBoard?: number;
    notes?: string;
  }[];
  notes?: string | null;
}

// --- queries ---

export function useHiveInspections(hiveId: string) {
  return useQuery({
    queryKey: ["hives", "detail", hiveId, "inspections"],
    queryFn: () => api.get<Inspection[]>(`/hives/${hiveId}/inspections`),
  });
}

export function useRecentInspections(limit = 5) {
  return useQuery({
    queryKey: ["inspections", "recent", limit],
    queryFn: () =>
      api.get<RecentInspection[]>("/inspections/recent", {
        params: { limit },
      }),
  });
}

// --- mutations ---

function useInvalidateInspections() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["hives"] });
    void queryClient.invalidateQueries({ queryKey: ["inspections"] });
    void queryClient.invalidateQueries({ queryKey: ["analytics"] });
  };
}

export function useCreateInspection() {
  const invalidate = useInvalidateInspections();
  return useMutation({
    mutationFn: (payload: InspectionPayload & { hiveId: string }) =>
      api.post<Inspection>("/inspections", payload),
    onSuccess: invalidate,
  });
}

export function useUpdateInspection() {
  const invalidate = useInvalidateInspections();
  return useMutation({
    mutationFn: ({
      id,
      ...payload
    }: InspectionPayload & { id: string }) =>
      api.put<Inspection>(`/inspections/${id}`, payload),
    onSuccess: invalidate,
  });
}

export function useDeleteInspection() {
  const invalidate = useInvalidateInspections();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ success: boolean }>(`/inspections/${id}`),
    onSuccess: invalidate,
  });
}

export function useBulkInspections() {
  const invalidate = useInvalidateInspections();
  return useMutation({
    mutationFn: (payload: {
      hiveIds: string[];
      date: string;
      notes?: string | null;
    }) =>
      api.post<{ success: boolean; count: number }>(
        "/inspections/bulk",
        payload,
      ),
    onSuccess: invalidate,
  });
}
