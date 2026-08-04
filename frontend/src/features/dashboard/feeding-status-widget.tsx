"use client";

import * as React from "react";
import Link from "next/link";
import { Droplets } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  useFeedingStatus,
  type FeedingStatusRow,
} from "@/features/feedings/hooks";
import { FeedingQuickActions } from "./feeding-actions";
import { WidgetFrame } from "./widget-frame";

/** How many rows a phone shows before the "view all" affordance. */
const MOBILE_ROWS = 3;

const STATE_BADGE: Record<FeedingStatusRow["state"], string> = {
  attention: "border-transparent bg-destructive text-destructive-foreground",
  stale: "border-transparent bg-primary/20 text-primary",
  ok: "border-transparent bg-secondary text-secondary-foreground",
};

const STATE_LABEL: Record<FeedingStatusRow["state"], string> = {
  attention: "Attention",
  stale: "Stale",
  ok: "OK",
};

/** One row per hive: counts, the latest feed, and the evidence-backed state. */
function FeedingRow({ row }: { row: FeedingStatusRow }) {
  const feeders = row.openFeeders + row.unverifiedFeeders;

  return (
    <li className="flex items-start justify-between gap-3 border-b border-border/60 pb-2 last:border-0 last:pb-0">
      <div className="min-w-0 space-y-0.5">
        <p className="flex items-center gap-2 text-sm">
          <Link
            href={`/hives/${row.hiveId}`}
            className="font-medium underline-offset-4 hover:underline"
          >
            {row.hiveName}
          </Link>
          <Badge variant="outline" className={cn(STATE_BADGE[row.state])}>
            {STATE_LABEL[row.state]}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {feeders} {feeders === 1 ? "feeder" : "feeders"}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">{row.evidence}</p>
      </div>
      {row.actionFeedingId ? (
        <FeedingQuickActions
          feedingId={row.actionFeedingId}
          hiveName={row.hiveName}
          unverified={row.unverifiedFeeders > 0}
        />
      ) : null}
    </li>
  );
}

export function FeedingStatusWidget() {
  const feeding = useFeedingStatus();
  const [showAll, setShowAll] = React.useState(false);
  const rows = feeding.data ?? [];
  const priority = rows.slice(0, MOBILE_ROWS);
  const hidden = rows.length - priority.length;

  return (
    <WidgetFrame
      title="Feeding status"
      icon={Droplets}
      isLoading={feeding.isPending}
      isError={feeding.isError}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No hive has been fed yet.
        </p>
      ) : (
        <>
          {/* Desktop and tablet: the whole list, urgent first, in a
              fixed-height scroller so the widget never pushes the rest of the
              dashboard off the screen. */}
          <ul className="hidden max-h-64 gap-2 overflow-y-auto pr-1 sm:grid">
            {rows.map((row) => (
              <FeedingRow key={row.hiveId} row={row} />
            ))}
          </ul>

          {/* Mobile: only the rows that need a decision, plus a way to see
              every hive. */}
          <ul className="grid gap-2 sm:hidden">
            {priority.map((row) => (
              <FeedingRow key={row.hiveId} row={row} />
            ))}
          </ul>
          {hidden > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 w-full sm:hidden"
              onClick={() => setShowAll(true)}
            >
              View all feeding status ({rows.length})
            </Button>
          )}

          <Sheet open={showAll} onOpenChange={setShowAll}>
            <SheetContent side="bottom" className="gap-3">
              <SheetHeader>
                <SheetTitle>Feeding status</SheetTitle>
                <SheetDescription>
                  One row per hive, most urgent first.
                </SheetDescription>
              </SheetHeader>
              <ul className="grid gap-3 overflow-y-auto pb-2">
                {rows.map((row) => (
                  <FeedingRow key={row.hiveId} row={row} />
                ))}
              </ul>
            </SheetContent>
          </Sheet>
        </>
      )}
    </WidgetFrame>
  );
}
