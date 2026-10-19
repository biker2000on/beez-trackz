import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { EconomicsReportView } from "@/features/operations/report-views";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/insights/economics");

export default function EconomicsReportPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <EconomicsReportView />
    </Suspense>
  );
}
