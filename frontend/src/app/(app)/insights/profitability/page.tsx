import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ProfitabilityView } from "@/features/operations/report-views";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/insights/profitability");

export default function ProfitabilityPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <ProfitabilityView />
    </Suspense>
  );
}
