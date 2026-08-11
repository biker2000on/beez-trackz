import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ReportDirectory } from "@/features/operations/report-directory";

export const metadata: Metadata = { title: "Outcome reports" };

export default function OutcomeReportsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-72 w-full" />}>
      <ReportDirectory group="outcomes" />
    </Suspense>
  );
}
