import * as React from "react";

import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { HoneyQuickActions } from "@/features/honey/quick-actions";
import { SalesWorkbench } from "@/features/workbench/sales-workbench";
import { SalesTab } from "@/features/honey/sales-tab";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/sales");

/**
 * Sales › Orders.
 *
 * The record dialogs used to be mounted by `sales/layout.tsx`, which put six
 * eager option-list fetches on *every* `/sales/*` route including the
 * workbench (wave 4 frontend finding 5). Sales navigation lives in the shell
 * now, so the dialogs are mounted by the one page that needs them and the
 * `s` shortcut still records a sale from here.
 */
export default function SalesPage() {
  return (
    <div className="mx-auto grid w-full max-w-none gap-4">
      <PageHeader
        subtitle="Record what sold and what was given away, and collect what is still owed."
        actions={<HoneyQuickActions variant="menu" />}
      />
      <SalesWorkbench embedded />
      <section>
        <h2 className="mb-3 text-lg font-semibold">Register</h2>
        {/* The register's All / Sales / Given away filter lives in the URL. */}
        <React.Suspense fallback={<Skeleton className="h-48 w-full" />}>
          <SalesTab />
        </React.Suspense>
      </section>
    </div>
  );
}
