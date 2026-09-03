"use client";

import { Cloud, CloudOff, History, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";

import { useOnline } from "./use-online";
import type { WorkFreshness } from "./types";

/** Local wall-clock time, or a dash when the timestamp is missing/unparsable. */
function clock(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Two of the six field states, side by side and never conflated:
 * **connection** (can a command reach the server at all) and **freshness**
 * (was this body produced by the server just now, or replayed from the
 * service worker's cache — design §4.5).
 *
 * Before this, a cached field response was rendered identically to a live
 * one: `api.ts` read only `content-type`, so `X-Beez-Cache: stale` never
 * reached React and stale evidence looked current in the yard.
 */
export function FreshnessMarker({
  freshness,
  asOf,
  isFetching,
  onRefresh,
}: {
  freshness: WorkFreshness | undefined;
  asOf: string | undefined;
  isFetching?: boolean;
  onRefresh?: () => void;
}) {
  const online = useOnline();
  const stale = freshness?.stale === true;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span
        data-testid="work-connection"
        data-state={online ? "online" : "offline"}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium",
          online
            ? "border-primary/30 bg-primary/5 text-foreground"
            : "border-warning bg-warning text-black/80",
        )}
      >
        {online ? (
          <Cloud className="size-3.5" aria-hidden />
        ) : (
          <CloudOff className="size-3.5" aria-hidden />
        )}
        {online ? "Online" : "Offline"}
      </span>

      <span
        data-testid="work-freshness"
        data-state={stale ? "stale" : "server"}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium",
          stale
            ? "border-warning bg-warning text-black/80"
            : "border-transparent bg-muted text-muted-foreground",
        )}
      >
        {stale ? (
          <History className="size-3.5" aria-hidden />
        ) : null}
        {stale
          ? `Stale — cached ${clock(freshness?.cachedAt ?? asOf)}`
          : `Live — read ${clock(asOf)}`}
      </span>

      {onRefresh ? (
        <button
          type="button"
          onClick={onRefresh}
          disabled={isFetching}
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium text-primary underline-offset-4 hover:underline disabled:opacity-60"
        >
          <RefreshCw
            className={cn("size-3.5", isFetching && "animate-spin")}
            aria-hidden
          />
          {isFetching ? "Refreshing" : "Refresh"}
        </button>
      ) : null}
    </div>
  );
}
