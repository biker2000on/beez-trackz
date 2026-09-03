"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { LaborControl } from "@/features/settings/labor-control";

import { useWorkYard } from "./api";
import { WorkSurface, type WorkSection } from "./work-surface";
import type { WorkFilter } from "./types";

/**
 * The Saturday walk: the same projection Today renders, grouped by yard.
 *
 * `/work/yard` and `/work/today` return the same items with the same ids,
 * commands and permissions; only the grouping differs, so an item resolved
 * here disappears from Today on the next read without either surface knowing
 * about the other.
 *
 * The `apiaryId: null` catch-all keeps hive-less recommendations visible —
 * they have no yard to be grouped under and were reachable nowhere else.
 */
export function YardQueueView({ filter = {} }: { filter?: WorkFilter }) {
  const yard = useWorkYard(filter);

  const sections: WorkSection[] = React.useMemo(() => {
    const yards = yard.data?.yards ?? [];
    return yards.map((entry) => ({
      key: entry.apiaryId ?? "all-yards",
      label: entry.apiaryName,
      items: entry.items,
      badge: (
        <span className="flex items-center gap-1">
          {entry.counts.urgent > 0 ? (
            <Badge variant="destructive">{entry.counts.urgent} urgent</Badge>
          ) : null}
          {entry.counts.high > 0 ? (
            <Badge variant="outline">{entry.counts.high} high</Badge>
          ) : null}
          {entry.counts.normal > 0 ? (
            <Badge variant="outline">{entry.counts.normal} normal</Badge>
          ) : null}
        </span>
      ),
      empty: "Nothing queued in this yard.",
    }));
  }, [yard.data]);

  return (
    <WorkSurface
      title="Yard queue"
      description="Saturday work by yard: open recommendations, honey that is ready, feeders that need a look, and lockout end dates. Cached for offline walks."
      sections={sections}
      freshness={yard.data?.freshness}
      asOf={yard.data?.asOf}
      isPending={yard.isPending}
      isFetching={yard.isFetching}
      isError={yard.isError}
      onRefresh={() => void yard.refetch()}
      emptyAll="Nothing queued. Open recommendations, harvest-ready supers, empty feeders and lockout end dates will land here."
      aside={<LaborControl quietWhenOff />}
    />
  );
}
