import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ReportsOverview } from "@/features/operations/reports-overview";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/insights");

export default function ReportsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <ReportsOverview />
    </Suspense>
  );
}
