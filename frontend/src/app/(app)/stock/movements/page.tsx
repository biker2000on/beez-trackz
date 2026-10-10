import * as React from "react";
import type { Metadata } from "next";

import { Skeleton } from "@/components/ui/skeleton";
import { MovementsSectionNav } from "@/features/honey/movements-section-nav";
import { ActivityTab } from "@/features/honey/activity-tab";

export const metadata: Metadata = { title: "Movements" };

/**
 * Stock › Movements: the inventory movement ledger. The canonical page —
 * /production/activity (Production › Activity) redirects here.
 */
export default function MovementsPage() {
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Movements</h1>
        <p className="text-sm text-muted-foreground">
          The stock ledger: receipts, jarring, sales, give-aways, use, loss
          and adjustments.
        </p>
      </div>
      <MovementsSectionNav />
      {/* The ledger's sort and filters live in the URL (useSearchParams). */}
      <React.Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <ActivityTab />
      </React.Suspense>
    </div>
  );
}
