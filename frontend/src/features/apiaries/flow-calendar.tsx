"use client";

import * as React from "react";
import { CalendarRange, Mountain } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/features/hives/lib";
import { useUnits } from "@/lib/use-units";
import { cn } from "@/lib/utils";

import { useFlowCalendar, type FlowCalendarRow, type FlowStatus } from "./hooks";

/**
 * Per-yard flow calendar: species x elevation band x last year's first/last
 * seen. It exists to answer one question — will this yard make sourwood this
 * year — so every row leads with where today sits against last year's window.
 *
 * The band is a filter on bloom, not a species model. Band scope widens the
 * rows to every yard the operator can see at the same height, because one
 * yard rarely has enough of its own seasons to predict anything.
 */

const STATUS_LABEL: Record<FlowStatus, string> = {
  blooming: "Blooming now",
  finished: "Done this year",
  upcoming: "Still coming",
  due: "Due now",
  missed: "Window passed",
  no_history: "No history",
};

const STATUS_CLASS: Record<FlowStatus, string> = {
  blooming:
    "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-50",
  finished: "border-border bg-muted text-muted-foreground",
  upcoming: "border-border bg-muted text-foreground",
  due: "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-50",
  missed: "border-border bg-muted text-muted-foreground",
  no_history: "border-dashed border-border bg-transparent text-muted-foreground",
};

function windowText(from: string | null, to: string | null): string {
  if (!from) return "No window yet";
  return to && to !== from
    ? `${formatDate(from)} – ${formatDate(to)}`
    : formatDate(from);
}

function FlowRow({ row }: { row: FlowCalendarRow }) {
  const reference = row.reference;
  return (
    <li className="grid gap-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="font-medium">{row.species}</p>
          <Badge variant="outline" className="gap-1">
            <Mountain className="size-3" />
            {row.elevationBandLabel}
          </Badge>
        </div>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-xs font-medium",
            STATUS_CLASS[row.status],
          )}
        >
          {STATUS_LABEL[row.status]}
          {row.status === "upcoming" && row.daysUntil != null
            ? ` · ${row.daysUntil} d`
            : ""}
        </span>
      </div>
      <p className="text-sm">
        Expected {windowText(row.expectedFirstSeen, row.expectedLastSeen)}
      </p>
      <p className="text-xs text-muted-foreground">
        {reference
          ? `${reference.year}: ${windowText(reference.firstSeen, reference.lastSeen)}`
          : "No earlier season on record"}
        {reference?.days ? ` (${reference.days} days)` : ""}
        {` · ${row.yearsObserved} ${row.yearsObserved === 1 ? "season" : "seasons"} recorded`}
        {row.atThisYard > 0
          ? ` · ${row.atThisYard} at this yard`
          : " · none at this yard yet"}
      </p>
      {row.current ? (
        <p className="text-xs text-muted-foreground">
          This year: {windowText(row.current.firstSeen, row.current.lastSeen)}
          {row.current.ongoing ? " (still open)" : ""}
        </p>
      ) : null}
    </li>
  );
}

export function FlowCalendarCard({ apiaryId }: { apiaryId: string }) {
  const [scope, setScope] = React.useState<"band" | "yard">("band");
  const calendar = useFlowCalendar(apiaryId, { scope });
  const units = useUnits();

  const elevation = calendar.data
    ? units.formatElevation(calendar.data.elevationM)
    : "";
  // A yard with no pin elevation has no band to widen to; the server already
  // fell back to yard scope, so the toggle should say so rather than lie.
  const banded = calendar.data?.elevationBand != null;

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarRange className="size-4 text-primary" />
              Flow calendar
            </CardTitle>
            <CardDescription>
              Species by elevation band, against last year&apos;s first and
              last seen. Will this yard make sourwood this year?
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              size="sm"
              variant={scope === "band" ? "default" : "outline"}
              disabled={!banded}
              onClick={() => setScope("band")}
            >
              This band
            </Button>
            <Button
              type="button"
              size="sm"
              variant={scope === "yard" ? "default" : "outline"}
              onClick={() => setScope("yard")}
            >
              This yard
            </Button>
          </div>
        </div>
        {calendar.data ? (
          <p className="text-xs text-muted-foreground">
            {calendar.data.elevationBandLabel}
            {elevation ? ` · ${elevation}` : ""}
            {calendar.data.scope === "band"
              ? " · every yard you can see at this height"
              : " · this yard's own rows only"}
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        {calendar.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : calendar.isError ? (
          <p className="text-sm text-muted-foreground">
            Could not build the flow calendar for this yard.
          </p>
        ) : calendar.data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {banded
              ? "No bloom seasons recorded at this elevation band yet. Record blooms over a season and the calendar builds itself."
              : "Set an elevation on this yard's pin, then record blooms — the band is what lets one yard borrow another's history."}
          </p>
        ) : (
          <ul className="divide-y">
            {calendar.data.rows.map((row) => (
              <FlowRow key={`${row.species}-${row.elevationBand ?? "none"}`} row={row} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
