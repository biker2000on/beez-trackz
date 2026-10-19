"use client";

import * as React from "react";

import { useWorkToday } from "./api";
import { OperationWork } from "./operation-work";
import { bucketCards, rollUp } from "./rollup";
import { todayItems, type WorkFilter } from "./types";
import { WorkSurface, type WorkSection } from "./work-surface";

/**
 * Today: one card per hive, Urgent / This week / Later.
 *
 * The items, their priorities and their commands arrive from the server
 * (`work.Today`); the client only rolls them up by hive, renames the
 * priorities into three buckets and hides stale evidence (`rollup.ts`).
 * `?view=all` is the old Recommendations page: the same read, widened to
 * snoozed and dismissed items, with stale items shown.
 */
export function TodayView({
  filter = {},
  description = "What each hive needs, highest first. Open the hive or log the inspection; dismiss and snooze are inside each card.",
  all = false,
}: {
  filter?: WorkFilter;
  description?: string;
  all?: boolean;
}) {
  const today = useWorkToday(filter);
  const [showStale, setShowStale] = React.useState(all);

  const asOf = today.data?.asOf ?? new Date().toISOString();
  const { cards, staleCount } = React.useMemo(
    () => rollUp(todayItems(today.data), asOf, { showStale }),
    [today.data, asOf, showStale],
  );
  const sections: WorkSection[] = React.useMemo(
    () => bucketCards(cards),
    [cards],
  );

  const counts = today.data?.counts;

  return (
    <div className="atlas-workspace">
      <WorkSurface
        description={description}
        sections={sections}
        freshness={today.data?.freshness}
        asOf={today.data?.asOf}
        isPending={today.isPending}
        isFetching={today.isFetching}
        isError={today.isError}
        onRefresh={() => void today.refetch()}
        emptyAll={
          staleCount > 0
            ? "Nothing current. Everything open on your hives is older than a season — show stale items to see it."
            : "Nothing is queued. Open recommendations, feeders that need a look, lockout end dates and harvest-ready hives land here."
        }
        staleCount={staleCount}
        showStale={showStale}
        onToggleStale={() => setShowStale((value) => !value)}
        aside={
          counts && counts.snoozed > 0 ? (
            <p
              data-testid="work-snoozed-count"
              className="text-sm text-muted-foreground"
            >
              {counts.snoozed} of the items below{" "}
              {counts.snoozed === 1 ? "is" : "are"} snoozed — shown because
              this view asked for them.
            </p>
          ) : null
        }
      />
      <OperationWork />
    </div>
  );
}
