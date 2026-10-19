import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ReportDirectory } from "@/features/operations/report-directory";
import { AdminReportGate } from "@/features/operations/reports-nav";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/insights/sales-planning");

export default function SalesPlanningReportsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-72 w-full" />}>
      <AdminReportGate>
        <ReportDirectory group="sales" />
      </AdminReportGate>
    </Suspense>
  );
}
