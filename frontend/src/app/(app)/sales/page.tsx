import type { Metadata } from "next";

import { HoneyQuickActions } from "@/features/honey/quick-actions";
import Link from "next/link";
import { SalesWorkbench } from "@/features/workbench/sales-workbench";
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
    <div className="mx-auto grid w-full max-w-none gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="atlas-eyebrow">Sales / Orders & register</p><h1 className="text-2xl font-bold tracking-tight">Sales</h1>
          <p className="text-sm text-muted-foreground">
            Jars, hive products, colonies, and equipment on one receipt.
            Totals are amounts invoiced; the paid column is what has actually
            been collected.
          </p>
        </div>
        <HoneyQuickActions variant="menu" />
      </div>
      <nav aria-label="Sales pages" className="flex flex-wrap gap-4 border-b pb-3 text-sm">{[["/sales/market-day","Market day"],["/sales/consignment","Consignment"],["/sales/customers","Customers & wholesale"],["/sales/expenses","Expenses"]].map(([href,label])=><Link key={href} href={href} className="inline-flex min-h-11 items-center underline">{label}</Link>)}</nav>
      <SalesWorkbench embedded/>
      <section><h2 className="mb-3 text-lg font-semibold">Orders & register</h2><SalesTab /></section>
    </div>
  );
}
