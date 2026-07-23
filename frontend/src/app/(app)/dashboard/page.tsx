import type { Metadata } from "next";

import { FeedingStatusWidget } from "@/features/dashboard/feeding-status-widget";
import { FrameShortageWidget } from "@/features/dashboard/frame-shortage-widget";
import { HiveOverviewWidget } from "@/features/dashboard/hive-overview-widget";
import { HoneySummaryWidget } from "@/features/dashboard/honey-summary-widget";
import { RecentInspectionsWidget } from "@/features/dashboard/recent-inspections-widget";
import { RecommendationsWidget } from "@/features/dashboard/recommendations-widget";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <HiveOverviewWidget />
        <RecommendationsWidget />
        <RecentInspectionsWidget />
        <FeedingStatusWidget />
        <FrameShortageWidget />
        <HoneySummaryWidget />
      </div>
    </div>
  );
}
