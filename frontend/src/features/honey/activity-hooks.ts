"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

import type { TimelineEntry } from "./types";

/** One row of GET /honey/activity: a timeline row plus its ledger columns. */
export interface ActivityEntry extends TimelineEntry {
  /** Jar size, "Bulk honey", or a sale's first line ("" when unknown). */
  item?: string;
  /** Distinct items the row touched. */
  itemCount?: number;
  /** The first harvest lot the row drew on, and how many lots it touched. */
  varietal?: string | null;
  lotCode?: string | null;
  lotCount?: number;
  /** Where stock left and where it arrived (a sale's venue). */
  fromLocation?: string | null;
  toLocation?: string | null;
  /**
   * The signed stock change the quantity sort orders by: jars when the row
   * moved jars, else pounds of bulk; a sale's items leave stock (negative).
   */
  qty?: number;
  qtyUnit?: "jars" | "lbs" | "items" | "";
}

/** One page of GET /honey/activity. */
export interface HoneyActivityPage {
  entries: ActivityEntry[];
  /** Null on the last page. */
  nextCursor: string | null;
}

/** Server sort keys (GET /honey/activity?sort=). */
export type ActivitySortKey = "date" | "quantity" | "type" | "item";
export type SortDir = "asc" | "desc";

export interface HoneyActivityFilters {
  /** Wire types to include; empty means every type. */
  types: string[];
  /** "bulk" or "jar:<jar size id>"; empty means every item. */
  items: string[];
  /** Varietal ids; empty means every varietal. */
  varietals: string[];
  /** Inventory location ids; empty means every location. */
  locations: string[];
  /** Every whitespace-separated term must match. */
  q: string;
  sort: ActivitySortKey;
  dir: SortDir;
}

export const HONEY_ACTIVITY_PAGE_SIZE = 50;

const sorted = (values: string[]) => [...values].sort();

/**
 * The movement ledger, a page at a time, in the server's sort order. Sort and
 * filters are part of the key and are applied by the server, so every page is
 * a page of the sorted, filtered ledger and changing either starts paging
 * over. Lives under ["honey", …] so every honey mutation's invalidation
 * refreshes it.
 */
export function useHoneyActivity(filters: HoneyActivityFilters) {
  const key = {
    types: sorted(filters.types),
    items: sorted(filters.items),
    varietals: sorted(filters.varietals),
    locations: sorted(filters.locations),
    q: filters.q.trim(),
    sort: filters.sort,
    dir: filters.dir,
  };
  return useInfiniteQuery({
    queryKey: ["honey", "activity", key],
    queryFn: async ({ pageParam }): Promise<HoneyActivityPage> => {
      const list = (values: string[]) =>
        values.length > 0 ? values.join(",") : undefined;
      // Unset (undefined) params are left out of the query string.
      const page = await api.get<Partial<HoneyActivityPage> | null>(
        "/honey/activity",
        {
          params: {
            limit: HONEY_ACTIVITY_PAGE_SIZE,
            cursor: pageParam || undefined,
            sort: key.sort,
            dir: key.dir,
            type: list(key.types),
            item: list(key.items),
            varietal: list(key.varietals),
            location: list(key.locations),
            q: key.q || undefined,
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

/** One choice of a ledger column filter. */
export interface ActivityFacet {
  value: string;
  label: string;
}

export interface ActivityFacets {
  items: ActivityFacet[];
  varietals: ActivityFacet[];
  locations: ActivityFacet[];
}

/** The Item, Varietal and Location filter choices (GET /honey/activity/facets). */
export function useHoneyActivityFacets() {
  return useQuery({
    queryKey: ["honey", "activity-facets"],
    queryFn: async (): Promise<ActivityFacets> => {
      const facets = await api.get<Partial<ActivityFacets> | null>(
        "/honey/activity/facets",
      );
      const list = (value: unknown) =>
        Array.isArray(value)
          ? (value as ActivityFacet[]).filter(
              (facet) =>
                facet && typeof facet.value === "string" && typeof facet.label === "string",
            )
          : [];
      return {
        items: list(facets?.items),
        varietals: list(facets?.varietals),
        locations: list(facets?.locations),
      };
    },
    staleTime: 5 * 60_000,
  });
}
