import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ReportDirectory } from "@/features/operations/report-directory";

export const metadata: Metadata = { title: "Finance reports" };

export default function FinanceReportsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-72 w-full" />}>
      <ReportDirectory group="finance" />
    </Suspense>
  );
}
