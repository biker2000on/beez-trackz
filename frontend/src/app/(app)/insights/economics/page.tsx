import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { EconomicsReportView } from "@/features/operations/report-views";

export const metadata: Metadata = { title: "Apiary economics" };

export default function EconomicsReportPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <EconomicsReportView />
    </Suspense>
  );
}
