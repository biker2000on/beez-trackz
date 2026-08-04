import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ExpensesView } from "@/features/operations/report-views";

export const metadata: Metadata = { title: "Expenses" };

export default function ExpensesPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <ExpensesView />
    </Suspense>
  );
}
