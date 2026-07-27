"use client";

import { useAccessProfile } from "@/features/access/api";

import { FeedingStatusWidget } from "./feeding-status-widget";
import { FrameShortageWidget } from "./frame-shortage-widget";
import { HiveOverviewWidget } from "./hive-overview-widget";
import { HoneySummaryWidget } from "./honey-summary-widget";
import { RecentInspectionsWidget } from "./recent-inspections-widget";
import { RecommendationsWidget } from "./recommendations-widget";

export function DashboardView() {
  const access = useAccessProfile();
  const isAdmin = access.data?.isAdmin === true;

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <HiveOverviewWidget />
        <RecommendationsWidget />
        <RecentInspectionsWidget />
        <FeedingStatusWidget />
        {isAdmin ? <FrameShortageWidget /> : null}
        {isAdmin ? <HoneySummaryWidget /> : null}
      </div>
    </div>
  );
}
