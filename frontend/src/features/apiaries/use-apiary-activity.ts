"use client";

import { useQuery } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";

import type { ActivityQuery, ApiaryActivity } from "./activity-types";

/** Query key prefix; invalidate `["apiaries", "detail", id, "activity"]` after a write. */
export function apiaryActivityKey(apiaryId: string, query: ActivityQuery = {}) {
  return [
    "apiaries",
    "detail",
    apiaryId,
    "activity",
    { from: query.from ?? null, to: query.to ?? null, types: query.types?.join(",") ?? "" },
  ] as const;
}

/**
 * The one fetch behind the apiary Timeline (Contract 1):
 * `GET /apiaries/{id}/activity?from=&to=&types=`.
 *
 * Reads stay fresh-on-mount (`staleTime: 0`): the Ledger's end-of-visit
 * summary links here, and the day it just saved must be on the page.
 */
export function useApiaryActivity(apiaryId: string, query: ActivityQuery = {}) {
  return useQuery({
    queryKey: apiaryActivityKey(apiaryId, query),
    queryFn: ({ signal }) =>
      api.get<ApiaryActivity>(`/apiaries/${apiaryId}/activity`, {
        signal,
        params: {
          from: query.from || undefined,
          to: query.to || undefined,
          types: query.types && query.types.length > 0 ? query.types.join(",") : undefined,
        },
      }),
    staleTime: 0,
    // Changing a filter or the range keeps the current days on screen
    // (dimmed) instead of flashing the skeleton; another apiary never does.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === apiaryId ? previous : undefined,
    // A 400 (bad range) or 404 (endpoint not deployed) will not fix itself.
    retry: (failures, error) =>
      !(error instanceof ApiError && error.status >= 400 && error.status < 500) &&
      failures < 1,
  });
}
