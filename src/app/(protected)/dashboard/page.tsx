import { Suspense } from "react";
import { WidgetCard } from "@/components/dashboard/widget-card";
import { HiveOverviewWidget } from "@/components/dashboard/hive-overview-widget";
import { RecommendationsWidget } from "@/components/dashboard/recommendations-widget";
import { RecentInspectionsWidget } from "@/components/dashboard/recent-inspections-widget";
import { FeedingStatusWidget } from "@/components/dashboard/feeding-status-widget";
import { FrameShortageWidget } from "@/components/dashboard/frame-shortage-widget";
import { HoneyInventoryWidget } from "@/components/dashboard/honey-inventory-widget";

function WidgetSkeleton() {
  return (
    <div className="animate-pulse space-y-2">
      <div className="h-4 bg-muted rounded w-3/4" />
      <div className="h-4 bg-muted rounded w-1/2" />
      <div className="h-4 bg-muted rounded w-2/3" />
    </div>
  );
}

export default function DashboardPage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <WidgetCard title="Hive Overview">
          <Suspense fallback={<WidgetSkeleton />}>
            <HiveOverviewWidget />
          </Suspense>
        </WidgetCard>

        <WidgetCard title="AI Recommendations">
          <Suspense fallback={<WidgetSkeleton />}>
            <RecommendationsWidget />
          </Suspense>
        </WidgetCard>

        <WidgetCard title="Recent Inspections">
          <Suspense fallback={<WidgetSkeleton />}>
            <RecentInspectionsWidget />
          </Suspense>
        </WidgetCard>

        <WidgetCard title="Feeding Status">
          <Suspense fallback={<WidgetSkeleton />}>
            <FeedingStatusWidget />
          </Suspense>
        </WidgetCard>

        <WidgetCard title="Frame Shortage">
          <Suspense fallback={<WidgetSkeleton />}>
            <FrameShortageWidget />
          </Suspense>
        </WidgetCard>

        <WidgetCard title="Honey Inventory">
          <Suspense fallback={<WidgetSkeleton />}>
            <HoneyInventoryWidget />
          </Suspense>
        </WidgetCard>
      </div>
    </div>
  );
}
