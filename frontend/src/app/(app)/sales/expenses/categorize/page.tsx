import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { FolioCategorize } from "@/features/commerce/folio-categorize";
import { AdminReportGate } from "@/features/operations/reports-nav";

export const metadata: Metadata = { title: "Categorize" };

/**
 * Bulk categorizing of the entries the Folio history import brought in,
 * linked from the "From Folio" card on /sales/expenses. Admin only, like the
 * expenses editor it belongs to.
 */
export default function CategorizePage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <AdminReportGate>
        <FolioCategorize />
      </AdminReportGate>
    </Suspense>
  );
}
