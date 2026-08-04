import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ReportsSectionNav } from "@/features/operations/reports-nav";

/** Reports chrome: the section menu that replaced two nested tab strips. */
export default function ReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-6">
      <Suspense fallback={<Skeleton className="h-11 w-full max-w-2xl" />}>
        <ReportsSectionNav />
      </Suspense>
      {children}
    </div>
  );
}
