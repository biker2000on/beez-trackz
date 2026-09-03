"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";

import { useWorkToday } from "./api";
import { WorkSurface, type WorkSection } from "./work-surface";
import type { WorkFilter } from "./types";

/**
 * Today: the field slice at its default filter.
 *
 * The two groups and their counts arrive from the server (`work.Today`,
 * `app/work/response.go`). Splitting "needs attention" from "today's field
 * actions" in the client — which is what `useFieldWork` did — meant the
 * dashboard could disagree with the yard queue about the same hive on the
 * same morning. There is no split here to disagree with.
 */
export function TodayView({
  filter = {},
  title = "Today",
  description = "Everything in front of you right now, with the observation behind each item. Highest first.",
}: {
  filter?: WorkFilter;
  title?: string;
  description?: string;
}) {
  const today = useWorkToday(filter);

  const sections: WorkSection[] = React.useMemo(() => {
    const groups = today.data?.groups ?? [];
    return groups.map((group) => ({
      key: group.key,
      label: group.label,
      items: group.items,
      badge:
        group.items.length > 0 ? (
          <Badge variant={group.key === "attention" ? "destructive" : "outline"}>
            {group.items.length}
          </Badge>
        ) : null,
      empty:
        group.key === "attention"
          ? "Nothing needs attention."
          : "Nothing else is due today.",
    }));
  }, [today.data]);

  const counts = today.data?.counts;

  return (
    <WorkSurface
      title={title}
      description={description}
      sections={sections}
      freshness={today.data?.freshness}
      asOf={today.data?.asOf}
      isPending={today.isPending}
      isFetching={today.isFetching}
      isError={today.isError}
      onRefresh={() => void today.refetch()}
      emptyAll="Nothing is queued. Open recommendations, feeders that need a look, lockout end dates and harvest-ready hives land here."
      aside={
        counts && counts.snoozed > 0 ? (
          <p
            data-testid="work-snoozed-count"
            className="text-xs text-muted-foreground"
          >
{counts.snoozed} of the items below {counts.snoozed === 1 ? "is" : "are"}{" "}
            snoozed — they are shown because this filter asked for them.
          </p>
        ) : null
      }
    />
  );
}
