import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { CustomersView } from "@/features/operations/report-views";
import { AdminReportGate } from "@/features/operations/reports-nav";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/sales/customers");

/**
 * Customers and wholesale price lists (design 2026-09-03 S12). Also a CRUD
 * editor, so also Sales; Insights keeps the reorder-due and wholesale-margin
 * figures as read-only panels that link here.
 */
export default function CustomersPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <AdminReportGate>
        <CustomersView />
      </AdminReportGate>
    </Suspense>
  );
}
