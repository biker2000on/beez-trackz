"use client";

/**
 * URL-backed UI state for tab strips and filter chips.
 *
 * Every surviving tab strip stores its active tab in a search param so views
 * are deep-linkable and the back button restores them: coming back from a
 * harvest session or a receipt lands on the tab you left, not the default.
 */

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Same-tick writes from multiple `set()` / `setSearchParams` calls compose
 * onto the last replace instead of each re-reading stale `searchParams`.
 */
let writeCache: { pathname: string; seen: string; written: string } | null =
  null;

function liveQuery(searchParams: { toString(): string }): string {
  return searchParams.toString();
}

function paramsForWrite(
  pathname: string,
  searchParams: { toString(): string },
): URLSearchParams {
  const seen = liveQuery(searchParams);
  if (
    writeCache &&
    writeCache.pathname === pathname &&
    writeCache.seen === seen
  ) {
    return new URLSearchParams(writeCache.written);
  }
  writeCache = { pathname, seen, written: seen };
  return new URLSearchParams(seen);
}

function commitWrite(
  router: { replace: (href: string, opts?: { scroll?: boolean }) => void },
  pathname: string,
  searchParams: { toString(): string },
  params: URLSearchParams,
) {
  const query = params.toString();
  writeCache = {
    pathname,
    seen: liveQuery(searchParams),
    written: query,
  };
  router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
}

/**
 * Read/write a single search param. Writing uses `replace` so a tab switch
 * does not bury the previous page under a history entry, and `scroll: false`
 * so the viewport stays put.
 */
export function useSearchParamState(
  key: string,
  fallback: string,
  allowed?: readonly string[],
): [string, (next: string) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const raw = searchParams.get(key);
  const value =
    raw != null && (allowed == null || allowed.includes(raw)) ? raw : fallback;

  const set = React.useCallback(
    (next: string) => {
      const params = paramsForWrite(pathname, searchParams);
      if (next === fallback) params.delete(key);
      else params.set(key, next);
      commitWrite(router, pathname, searchParams, params);
    },
    [fallback, key, pathname, router, searchParams],
  );

  return [value, set];
}

/** Merge several search params in one `replace` (and with any same-tick sets). */
export function useSetSearchParams(): (
  updates: Record<string, string | null>,
) => void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return React.useCallback(
    (updates: Record<string, string | null>) => {
      const params = paramsForWrite(pathname, searchParams);
      for (const [key, next] of Object.entries(updates)) {
        if (next == null) params.delete(key);
        else params.set(key, next);
      }
      commitWrite(router, pathname, searchParams, params);
    },
    [pathname, router, searchParams],
  );
}

/** Numeric search param (report year selectors). */
export function useNumberParam(
  key: string,
  fallback: number,
): [number, (next: number) => void] {
  const [raw, setRaw] = useSearchParamState(key, String(fallback));
  const parsed = Number(raw);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  const set = React.useCallback(
    (next: number) => setRaw(String(next)),
    [setRaw],
  );
  return [value, set];
}
