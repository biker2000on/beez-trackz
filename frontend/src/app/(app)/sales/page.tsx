import type { Metadata } from "next";

import { SalesTab } from "@/features/honey/sales-tab";

export const metadata: Metadata = { title: "Sales" };

export default function SalesPage() {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Sales</h1>
        <p className="text-sm text-muted-foreground">
          Jars, colonies, and equipment on one receipt. Totals are amounts
          invoiced; the paid column is what has actually been collected.
        </p>
      </div>
      <SalesTab />
    </div>
  );
}
