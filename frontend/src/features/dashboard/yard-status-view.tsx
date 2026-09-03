"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { HiveOverviewWidget } from "./hive-overview-widget";
import { RecentInspectionsWidget } from "./recent-inspections-widget";

/**
 * Yard status and recent activity — the two dashboard widgets §4.1 relocates
 * to the Yard area.
 *
 * They still live in `features/dashboard` because moving the folder is wave
 * 5's job (it renames every route and every import in one change); what
 * matters this wave is that the operator finds them under `/yard` and that
 * the dashboard no longer needs them to justify its existence.
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
    </div>
  );
}
