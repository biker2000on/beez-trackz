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

// --- queries ---

export function useApiaries() {
  return useQuery({
    queryKey: ["apiaries", "list"],
    queryFn: () => api.get<ApiaryListItem[]>("/apiaries"),
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
