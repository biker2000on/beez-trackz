import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ExpensesView } from "@/features/operations/report-views";
import { AdminReportGate } from "@/features/operations/reports-nav";

export const metadata: Metadata = { title: "Expenses" };

/**
 * Money out (design 2026-09-03 S11). It is a CRUD editor, not a report, so it
 * lives in Sales rather than in read-only Insights. The admin gate used to
 * come from the reports layout; it comes with the page now.
 */
export default function ExpensesPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <AdminReportGate>
        <ExpensesView />
      </AdminReportGate>
    </Suspense>
  );
}
