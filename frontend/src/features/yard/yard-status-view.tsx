"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { IncidentLog } from "@/features/operations/incident-log";

import { HiveOverviewWidget } from "./hive-overview-widget";
import { RecentInspectionsWidget } from "./recent-inspections-widget";

/**
 * Yard status and recent activity — the two widgets §4.1 relocates to the
 * Yard area, now in the Yard feature folder alongside the route that renders
 * them. The page they came from no longer exists.
 *
 * The incident log lands here too. Wave 7 deleted the old `/operations/
 * yard-queue` page that rendered it, and the roadmap keeps the eight-row log
 * alive until Observation and Activity represent its rows, permissions,
 * delete behaviour and snapshot registration. Yard status is where dated
 * field history belongs in the meantime; the queue is the work projection and
 * takes no non-work rows.
 */
export function YardStatusView() {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-1">
          <h1 className="text-2xl font-bold tracking-tight">Yard</h1>
          <p className="text-sm text-muted-foreground">
            Hive and apiary status, and what was inspected recently.
          </p>
        </div>
        <Link
          href="/yard/queue"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          Yard queue
          <ArrowRight className="size-3.5" />
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <HiveOverviewWidget />
      </div>

      <RecentInspectionsWidget />

      <IncidentLog />
    </div>
  );
}
