import * as React from "react";
import type { Metadata } from "next";

import { Skeleton } from "@/components/ui/skeleton";
import { ActivityTab } from "@/features/honey/activity-tab";

export const metadata: Metadata = { title: "Honey activity" };

export default function ActivityPage() {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Activity</h1>
        <p className="text-sm text-muted-foreground">
          The honey ledger: jarring, sales, give-aways, use, loss and
          adjustments.
        </p>
      </div>
      {/* The ledger's filters live in the URL (useSearchParams). */}
      <React.Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <ActivityTab />
      </React.Suspense>
    </div>
  );
}
