import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { YieldReportView } from "@/features/operations/report-views";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/insights/yield");

export default function YieldReportPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <YieldReportView />
    </Suspense>
  );
}
