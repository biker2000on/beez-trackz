"use client";

import { useInfiniteQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

import type { TimelineEntry } from "./types";

/** One page of GET /honey/activity. */
export interface HoneyActivityPage {
  entries: TimelineEntry[];
  /** Null on the last page. */
  nextCursor: string | null;
}

export interface HoneyActivityFilters {
  /** Wire types to include; empty means every type. */
  types: string[];
  /** Every whitespace-separated term must match. */
  q: string;
}

export const HONEY_ACTIVITY_PAGE_SIZE = 50;

/**
 * The honey ledger, newest first, a page at a time. Filters are part of the
 * key and are applied by the server, so every page is a page of the
 * filtered ledger. Lives under ["honey", …] so every honey mutation's
 * invalidation refreshes it.
 */
export function useHoneyActivity(filters: HoneyActivityFilters) {
  const types = [...filters.types].sort();
  const q = filters.q.trim();
  return useInfiniteQuery({
    queryKey: ["honey", "activity", { types, q }],
    queryFn: async ({ pageParam }): Promise<HoneyActivityPage> => {
      const page = await api.get<Partial<HoneyActivityPage> | null>(
        "/honey/activity",
        {
          params: {
            limit: HONEY_ACTIVITY_PAGE_SIZE,
            ...(pageParam ? { cursor: pageParam } : {}),
            ...(types.length > 0 ? { type: types.join(",") } : {}),
            ...(q ? { q } : {}),
          },
        },
      );
      // Tolerate a malformed body (an empty mock, a proxy error page) as an
      // empty last page rather than crashing the ledger.
      return {
        entries: Array.isArray(page?.entries) ? page.entries : [],
        nextCursor: typeof page?.nextCursor === "string" ? page.nextCursor : null,
      };
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
