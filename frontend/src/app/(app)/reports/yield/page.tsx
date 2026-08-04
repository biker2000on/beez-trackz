import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { YieldReportView } from "@/features/operations/report-views";

export const metadata: Metadata = { title: "Honey yield" };

export default function YieldReportPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <YieldReportView />
    </Suspense>
  );
}
