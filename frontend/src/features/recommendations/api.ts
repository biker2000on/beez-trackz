"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const REC_VIEWS = ["pending", "all", "dismissed"] as const;
export type RecView = (typeof REC_VIEWS)[number];

/** Triage states, action-center style. */
export type RecState = "dismissed" | "snoozed" | "open";

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
  snoozedUntil: string | null;
  dismissedAt: string | null;
}

export function useRecommendations(view: RecView = "pending") {
  return useQuery({
    queryKey: ["recommendations", view],
    queryFn: () =>
      api.get<Recommendation[]>(`/recommendations?view=${view}`),
  });
}

function useInvalidateRecommendations() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["recommendations"] });
  };
}

/**
 * Bulk triage: one request for any number of recommendations. `days` only
 * applies to state "snoozed" (server default: 7).
 */
export function useSetRecommendationState() {
  const invalidate = useInvalidateRecommendations();
  return useMutation({
    mutationFn: ({
      ids,
      state,
      days,
    }: {
      ids: string[];
      state: RecState;
      days?: number;
    }) =>
      api.post<{ updated: number }>("/recommendations/state", {
        ids,
        state,
        days,
      }),
    onSuccess: invalidate,
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
