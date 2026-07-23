"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Recommendation shape from GET /recommendations. */
export interface Recommendation {
  id: string;
  hiveId: string | null;
  type: string;
  message: string;
  priority: Priority;
  dismissed: boolean;
  createdAt: string;
  hiveName: string | null;
}

export function useRecommendations() {
  return useQuery({
    queryKey: ["recommendations"],
    queryFn: () => api.get<Recommendation[]>("/recommendations"),
  });
}

export function useDismissRecommendation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ success: boolean }>(`/recommendations/${id}/dismiss`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recommendations"] });
    },
  });
}

export function useBulkDismissRecommendations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) =>
          api.post<{ success: boolean }>(`/recommendations/${id}/dismiss`),
        ),
      );
      const failed = results.filter(
        (result) => result.status === "rejected",
      ).length;
      if (failed > 0) {
        throw new Error(`${failed} of ${ids.length} dismissals failed`);
      }
      return ids.length;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["recommendations"] });
    },
  });
}

export function useRunRecommendationCheck() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ queued: boolean }>("/recommendations/run"),
    onSuccess: () => {
      // The check runs in a background job; refetch shortly after so fresh
      // recommendations appear without a manual reload.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["recommendations"] });
      }, 4000);
    },
  });
}
