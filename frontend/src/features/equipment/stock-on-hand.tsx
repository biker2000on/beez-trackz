"use client";

import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { STOCK_TABS, type StockTab } from "./stock-tabs";
import { StockWorkspace } from "./stock-workspace";

/** Stock › On hand: one page, three ledger kinds as tabs. */
export function StockOnHand({ tab }: { tab: StockTab }) {
  const current = STOCK_TABS.find((entry) => entry.id === tab) ?? STOCK_TABS[0];
  return (
    <div className="atlas-workspace">
      <PageHeader
        subtitle="What is physically here, what is committed, and what you can still use or sell."
        actions={
          current.manage ? (
            <Button asChild variant="outline">
              <Link href={current.manage.href}>{current.manage.label}</Link>
            </Button>
          ) : null
        }
      />
      <nav aria-label="Stock kinds" className="border-b">
        <ul className="flex flex-wrap gap-x-4">
          {STOCK_TABS.map((entry) => {
            const active = entry.id === current.id;
            return (
              <li key={entry.id}>
                <Link
                  href={entry.id === "bulk" ? "/stock" : `/stock?tab=${entry.id}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex min-h-11 items-center border-b-2 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "border-primary font-semibold text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {entry.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <StockWorkspace category={current.id} />
    </div>
  );
}
