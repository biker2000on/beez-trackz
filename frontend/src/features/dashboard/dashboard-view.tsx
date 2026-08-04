"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { useAccessProfile } from "@/features/access/api";

import { FeedingStatusWidget } from "./feeding-status-widget";
import { FrameShortageWidget } from "./frame-shortage-widget";
import { HiveOverviewWidget } from "./hive-overview-widget";
import { HoneySummaryWidget } from "./honey-summary-widget";
import { NeedsAttentionWidget } from "./needs-attention-widget";
import { RecentInspectionsWidget } from "./recent-inspections-widget";
import { TodaysActionsWidget } from "./todays-actions-widget";

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

const REPORTS = [
  { href: "/reports", label: "Reports and analytics" },
  { href: "/recommendations", label: "All recommendations" },
];

/**
 * The dashboard is ordered by what the beekeeper has to do, not by what the
 * app can display: the work first (with the evidence behind each item), then
 * status, then history, then reporting.
 */
export function DashboardView() {
  const access = useAccessProfile();
  const isAdmin = access.data?.isAdmin === true;

  return (
    <div className="grid gap-8">
      <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>

      <section className="grid gap-4 lg:grid-cols-2">
        <NeedsAttentionWidget />
        <TodaysActionsWidget />
      </section>

      <section className="grid gap-3">
        <SectionHeading>Hive and apiary status</SectionHeading>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <HiveOverviewWidget />
          {isAdmin ? <FrameShortageWidget /> : null}
          {isAdmin ? <HoneySummaryWidget /> : null}
        </div>
      </section>

      <section className="grid gap-3">
        <SectionHeading>Feeding status</SectionHeading>
        <FeedingStatusWidget />
      </section>

      <section className="grid gap-3">
        <SectionHeading>Recent activity</SectionHeading>
        <RecentInspectionsWidget />
      </section>

      <section className="grid gap-3">
        <SectionHeading>Reporting</SectionHeading>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {REPORTS.map((report) => (
            <Link
              key={report.href}
              href={report.href}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {report.label}
              <ArrowRight className="size-3.5" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
