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
      const params = new URLSearchParams(searchParams.toString());
      if (next === fallback) params.delete(key);
      else params.set(key, next);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [fallback, key, pathname, router, searchParams],
  );

  return [value, set];
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
