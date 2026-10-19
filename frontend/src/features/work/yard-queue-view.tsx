"use client";

import * as React from "react";

import { useHives } from "@/features/hives/hooks";
import { LaborControl } from "@/features/operations/labor-control";

import { useWorkYard } from "./api";
import { isFieldActionable, rollUp, rosterOf } from "./rollup";
import type { WorkFilter } from "./types";
import { WorkSurface, type WorkSection } from "./work-surface";

/**
 * The Visit queue: Today's hive cards grouped by apiary for the walk, kept
 * to what can be done standing at a hive.
 *
 * `/work/yard` and `/work/today` return the same items with the same ids,
 * commands and permissions; only the grouping differs, so an item resolved
 * here disappears from Today on the next read without either surface knowing
 * about the other. The roll-up, the stale rule and the cards are shared.
 */
export function YardQueueView({ filter = {} }: { filter?: WorkFilter }) {
  const yard = useWorkYard(filter);
  const hives = useHives({ includeArchived: true });
  const [showStale, setShowStale] = React.useState(false);

  const asOf = yard.data?.asOf ?? new Date().toISOString();
  const roster = React.useMemo(() => rosterOf(hives.data), [hives.data]);
  const { sections, staleCount } = React.useMemo(() => {
    const yards = yard.data?.yards ?? [];
    let stale = 0;
    const built: WorkSection[] = [];
    for (const entry of yards) {
      const result = rollUp(entry.items.filter(isFieldActionable), asOf, {
        showStale,
        roster,
      });
      stale += result.staleCount;
      if (result.cards.length === 0 && entry.apiaryId === null) continue;
      built.push({
        key: entry.apiaryId ?? "all-yards",
        label: entry.apiaryName,
        cards: result.cards,
        empty: "Nothing to do in this apiary.",
      });
    }
    return { sections: built, staleCount: stale };
  }, [yard.data, asOf, showStale, roster]);

  return (
    <WorkSurface
      description="Today's hives grouped by apiary for the walk. Cached for offline use."
      sections={sections}
      freshness={yard.data?.freshness}
      asOf={yard.data?.asOf}
      isPending={yard.isPending || hives.isPending}
      isFetching={yard.isFetching}
      isError={yard.isError}
      onRefresh={() => void yard.refetch()}
      emptyAll="Nothing to visit. Open recommendations, harvest-ready supers and empty feeders will land here."
      staleCount={staleCount}
      showStale={showStale}
      onToggleStale={() => setShowStale((value) => !value)}
      aside={<LaborControl quietWhenOff />}
    />
  );
}
