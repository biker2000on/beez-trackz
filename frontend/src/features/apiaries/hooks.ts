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
  elevationM: number | null;
  elevationSource: string | null;
  /** Forage circle drawn on the map; also the Immich pin-search radius. */
  forageRadiusM: number;
  notes: string | null;
  createdAt: string;
  hiveCount: number;
}

export interface Apiary {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  elevationM: number | null;
  elevationSource: string | null;
  forageRadiusM: number;
  notes: string | null;
  canvasLayout: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ApiaryPayload {
  name: string;
  latitude?: number | null;
  longitude?: number | null;
  elevationM?: number | null;
  elevationSource?: string | null;
  forageRadiusM?: number | null;
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
  /** Height the bloom was seen at, and the band derived from it. */
  elevationM: number | null;
  elevationBand: ElevationBandId | null;
  elevationBandLabel: string;
  createdAt: string;
}

/** Mirrors elevationBandDefs in backend/internal/httpapi/routes_bloom.go. */
export type ElevationBandId =
  | "valley"
  | "foothill"
  | "midslope"
  | "ridge"
  | "summit";

export interface ElevationBand {
  id: ElevationBandId;
  label: string;
  minM: number | null;
  maxM: number | null;
}

/** One species' window in one season, aggregated over the rows in scope. */
export interface FlowSeason {
  year: number;
  firstSeen: string;
  lastSeen: string | null;
  days: number | null;
  abundance: number | null;
  observations: number;
  atThisYard: number;
  yards: number;
  ongoing: boolean;
}

export type FlowStatus =
  | "blooming"
  | "finished"
  | "upcoming"
  | "due"
  | "missed"
  | "no_history";

export interface FlowCalendarRow {
  species: string;
  elevationBand: ElevationBandId | null;
  elevationBandLabel: string;
  reference: FlowSeason | null;
  current: FlowSeason | null;
  seasons: FlowSeason[];
  expectedFirstSeen: string | null;
  expectedLastSeen: string | null;
  status: FlowStatus;
  daysUntil: number | null;
  yearsObserved: number;
  atThisYard: number;
}

export interface FlowCalendar {
  apiaryId: string;
  year: number;
  scope: "band" | "yard";
  elevationM: number | null;
  elevationBand: ElevationBandId | null;
  elevationBandLabel: string;
  forageRadiusM: number;
  bands: ElevationBand[];
  rows: FlowCalendarRow[];
}

/** Night lows at the pin, read out of the weather snapshot already cached. */
export interface FrostSummary {
  available: boolean;
  thresholdF: number;
  windowStart: string;
  windowEnd: string;
  nightsLastWeek: number;
  hardFreezeNights: number;
  lowestF: number | null;
  dates: string[];
  upcomingNights: number;
  nextFrostDate: string | null;
  summary: string;
}

export interface ApiaryWeather {
  apiaryId: string;
  source: string;
  fetchedAt: string;
  /**
   * The daily arrays open on the past week (past_days). This is the index of
   * today, so the outlook renders without the history behind it.
   */
  forecastStartIndex: number;
  frost: FrostSummary;
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

/**
 * Bloom rows for a yard. `band` filters by elevation band — "none" asks for
 * the rows recorded before the yard had a pin elevation, undefined for all.
 */
export function useBlooms(
  apiaryId: string,
  filter: "active" | "history",
  band?: ElevationBandId | "none",
) {
  return useQuery({
    queryKey: ["apiaries", "detail", apiaryId, "blooms", filter, band ?? "all"],
    queryFn: () =>
      api.get<BloomObservation[]>(`/apiaries/${apiaryId}/blooms`, {
        params: { filter, band },
      }),
  });
}

/** The band ladder, for filters and labels. Static — cache it hard. */
export function useElevationBands() {
  return useQuery({
    queryKey: ["bloom-elevation-bands"],
    queryFn: () =>
      api.get<ElevationBand[]>("/bloom-observations/elevation-bands"),
    staleTime: Infinity,
  });
}

/**
 * Species x elevation band x last year's window: "will this yard make
 * sourwood this year". Band scope widens to every yard at the same height,
 * because one yard rarely has enough of its own years to answer that.
 */
export function useFlowCalendar(
  apiaryId: string,
  options: { scope?: "band" | "yard"; year?: number } = {},
) {
  const scope = options.scope ?? "band";
  return useQuery({
    queryKey: [
      "apiaries",
      "detail",
      apiaryId,
      "flow-calendar",
      scope,
      options.year ?? "current",
    ],
    queryFn: () =>
      api.get<FlowCalendar>(`/apiaries/${apiaryId}/flow-calendar`, {
        params: { scope, year: options.year },
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
    // The flow calendar is built from these rows; a new bloom moves it.
    void queryClient.invalidateQueries({
      predicate: (query) =>
        Array.isArray(query.queryKey) &&
        query.queryKey.includes("flow-calendar"),
    });
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
      /** Omitted means "the yard pin's height"; the server fills it in. */
      elevationM?: number | null;
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
