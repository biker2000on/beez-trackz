import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { SurvivalReportView } from "@/features/operations/report-views";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/insights/survival");

export default function SurvivalReportPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <SurvivalReportView />
    </Suspense>
  );
}
