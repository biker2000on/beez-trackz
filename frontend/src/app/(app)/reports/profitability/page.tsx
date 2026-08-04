import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ProfitabilityView } from "@/features/operations/report-views";

export const metadata: Metadata = { title: "Profitability" };

export default function ProfitabilityPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <ProfitabilityView />
    </Suspense>
  );
}
