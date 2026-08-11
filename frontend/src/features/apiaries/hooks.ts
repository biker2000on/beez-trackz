"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/lib/api";

// --- types (mirror backend/internal/httpapi/routes_apiaries.go + routes_bloom.go) ---

export interface ApiaryListItem {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
  createdAt: string;
  hiveCount: number;
}

export interface Apiary {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
  canvasLayout: unknown;
  satelliteImageKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiaryPayload {
  name: string;
  latitude?: number | null;
  longitude?: number | null;
  notes?: string | null;
}

export interface BloomObservation {
  id: string;
  apiaryId: string;
  species: string;
  dateFirstSeen: string;
  dateLastSeen: string | null;
  year: number;
  abundance: number | null;
  notes: string | null;
  createdAt: string;
}

export interface ApiaryWeather {
  apiaryId: string;
  source: string;
  fetchedAt: string;
  alerts: Array<{
    date: string;
    severity: "normal" | "high";
    message: string;
  }>;
  feedingStatus: {
    activeFeeders: number;
    lastFeedingAt: string | null;
    needsAttention: boolean;
  };
  forecast: {
    timezone: string;
    current: {
      time: string;
      temperature_2m: number;
      apparent_temperature: number;
      relative_humidity_2m: number;
      weather_code: number;
      wind_speed_10m: number;
      is_day: number;
    };
    daily: {
      time: string[];
      weather_code: number[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_sum: number[];
      precipitation_probability_max: number[];
      wind_speed_10m_max: number[];
    };
  };
}

export interface BloomPrediction {
  species: string;
  predictedDate: string;
  windowStart: string;
  windowEnd: string;
  confidence: "low" | "medium" | "high";
  observations: number;
  radiusMiles: number;
  weatherShiftDays: number;
  method: string;
}

export interface BloomPredictions {
  apiaryId: string;
  latitude: number;
  longitude: number;
  predictions: BloomPrediction[];
}

// --- queries ---

export function useApiaries(enabled = true) {
  return useQuery({
    queryKey: ["apiaries", "list"],
    queryFn: () => api.get<ApiaryListItem[]>("/apiaries"),
    enabled,
  });
}

export function useApiary(id: string) {
  return useQuery({
    queryKey: ["apiaries", "detail", id],
    queryFn: () => api.get<Apiary>(`/apiaries/${id}`),
  });
}

export function useBlooms(apiaryId: string, filter: "active" | "history") {
  return useQuery({
    queryKey: ["apiaries", "detail", apiaryId, "blooms", filter],
    queryFn: () =>
      api.get<BloomObservation[]>(`/apiaries/${apiaryId}/blooms`, {
        params: { filter },
      }),
  });
}

export function useBloomSpecies() {
  return useQuery({
    queryKey: ["bloom-species"],
    queryFn: () => api.get<string[]>("/bloom-observations/species"),
  });
}

export function useApiaryWeather(apiaryId: string) {
  return useQuery({
    queryKey: ["apiaries", "detail", apiaryId, "weather"],
    queryFn: () => api.get<ApiaryWeather>(`/apiaries/${apiaryId}/weather`),
    staleTime: 15 * 60_000,
    retry: 1,
  });
}

export function useBloomPredictions(apiaryId: string) {
  return useQuery({
    queryKey: ["apiaries", "detail", apiaryId, "bloom-predictions"],
    queryFn: () =>
      api.get<BloomPredictions>(`/apiaries/${apiaryId}/bloom-predictions`),
    staleTime: 15 * 60_000,
    retry: 1,
  });
}

// --- mutations ---

export function useCreateApiary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ApiaryPayload) =>
      api.post<Apiary>("/apiaries", payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["apiaries"] });
    },
  });
}

export function useUpdateApiary(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ApiaryPayload) =>
      api.put<Apiary>(`/apiaries/${id}`, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["apiaries"] });
    },
  });
}

export function useDeleteApiary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ success: boolean }>(`/apiaries/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["apiaries"] });
    },
  });
}

export function useBulkDeleteApiaries() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => api.delete<{ success: boolean }>(`/apiaries/${id}`)),
      );
      return {
        deleted: results.filter((result) => result.status === "fulfilled")
          .length,
        failed: results.filter((result) => result.status === "rejected").length,
      };
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["apiaries"] });
    },
  });
}

function useInvalidateBlooms() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      predicate: (query) =>
        Array.isArray(query.queryKey) && query.queryKey.includes("blooms"),
    });
    void queryClient.invalidateQueries({ queryKey: ["bloom-species"] });
  };
}

export function useCreateBloom() {
  const invalidate = useInvalidateBlooms();
  return useMutation({
    mutationFn: (payload: {
      apiaryId: string;
      species: string;
      dateFirstSeen: string;
      abundance?: number | null;
      notes?: string | null;
    }) => api.post<BloomObservation>("/bloom-observations", payload),
    onSuccess: invalidate,
  });
}

export function useEndBloom() {
  const invalidate = useInvalidateBlooms();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ success: boolean }>(`/bloom-observations/${id}/end`),
    onSuccess: invalidate,
  });
}

export function useDeleteBloom() {
  const invalidate = useInvalidateBlooms();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ success: boolean }>(`/bloom-observations/${id}`),
    onSuccess: invalidate,
  });
}
