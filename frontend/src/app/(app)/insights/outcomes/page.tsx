import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ReportDirectory } from "@/features/operations/report-directory";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/insights/outcomes");

export default function OutcomeReportsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-72 w-full" />}>
      <ReportDirectory group="outcomes" />
    </Suspense>
  );
}
