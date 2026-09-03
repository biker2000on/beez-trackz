import type { Metadata } from "next";

import { HoneyQuickActions } from "@/features/honey/quick-actions";
import { SalesTab } from "@/features/honey/sales-tab";

export const metadata: Metadata = { title: "Sales" };

/**
 * Sales orders.
 *
 * The record dialogs used to be mounted by `sales/layout.tsx`, which put six
 * eager option-list fetches on *every* `/sales/*` route including the
 * workbench (wave 4 frontend finding 5). Sales navigation lives in the shell
 * now, so the dialogs are mounted by the one page that needs them and the
 * `s` shortcut still records a sale from here.
 */
export default function SalesPage() {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Sales</h1>
          <p className="text-sm text-muted-foreground">
            Jars, hive products, colonies, and equipment on one receipt.
            Totals are amounts invoiced; the paid column is what has actually
            been collected.
          </p>
        </div>
        <HoneyQuickActions variant="menu" />
      </div>
      <SalesTab />
    </div>
  );
}
