import * as React from "react";

import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { ActivityTab } from "@/features/honey/activity-tab";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/stock/movements");

/**
 * Stock › Movements: the inventory movement ledger. The canonical page —
 * /production/activity (Production › Activity) redirects here.
 */
export default function MovementsPage() {
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4">
      <PageHeader subtitle="Every receipt, jarring, sale, give-away, use, loss and adjustment, in order." />
      {/* The ledger's sort and filters live in the URL (useSearchParams). */}
      <React.Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <ActivityTab />
      </React.Suspense>
    </div>
  );
}
