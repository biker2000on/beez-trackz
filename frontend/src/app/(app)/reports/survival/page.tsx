import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { SurvivalReportView } from "@/features/operations/report-views";

export const metadata: Metadata = { title: "Winter survival" };

export default function SurvivalReportPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <SurvivalReportView />
    </Suspense>
  );
}
