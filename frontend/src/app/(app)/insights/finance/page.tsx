import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ReportDirectory } from "@/features/operations/report-directory";
import { AdminReportGate } from "@/features/operations/reports-nav";

export const metadata: Metadata = { title: "Finance reports" };

export default function FinanceReportsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-72 w-full" />}>
      <AdminReportGate>
        <ReportDirectory group="finance" />
      </AdminReportGate>
    </Suspense>
  );
}
