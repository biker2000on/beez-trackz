"use client";

/**
 * The Insights report directory and the admin gate its finance pages share.
 * The three groups (Outcomes, Finance, Sales & planning) are nav rows in
 * `NAV_ITEMS`; this file only describes the report cards.
 *
 * The compliance packet and the Folio reconciliation report are Insights'
 * own — they arrived here from Settings with the split (design 2026-09-03
 * §6.3, S5 and S6), so they are reports and not configuration.
 *
 * Expenses and Customers are listed here but live under Sales (design
 * 2026-09-03 S11, S12): they are CRUD editors, and Insights is read-only.
 * They are therefore cross-area links in the directory and deliberately
 * absent from `matches`, so opening one does not leave the Insights section
 * menu highlighted over a Sales route.
 */

import type { ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { useAccessProfile } from "@/features/access/api";

export const REPORT_PAGES = [
  { href: "/insights", label: "Overview", description: "Headline numbers for the season." },
  { href: "/insights/survival", label: "Winter survival", description: "Hives through winter, by apiary, stand and queen line." },
  { href: "/insights/yield", label: "Honey yield", description: "Hive leaderboard and year-over-year harvest weight." },
  { href: "/insights/economics", label: "Apiary economics", description: "Cost and margin per apiary, allocated by yield.", adminOnly: true },
  { href: "/insights/profitability", label: "Profitability", description: "Revenue, expenses, break-even prices and margins.", adminOnly: true },
  { href: "/sales/expenses", label: "Expenses", description: "Everything spent this season, assignable to lots and hives. Edited in Sales.", adminOnly: true },
  { href: "/insights/bottling", label: "Bottle next", description: "What to bottle next from recent demand.", adminOnly: true },
  { href: "/sales/customers", label: "Customers", description: "Customer list, reorder reminders and wholesale price lists. Edited in Sales.", adminOnly: true },
  { href: "/insights/compliance", label: "Compliance packet", description: "Hives, treatments, lots, sales and withdrawal windows, in one export.", adminOnly: true },
  { href: "/insights/reconciliation", label: "Folio reconciliation", description: "What the feed pushed, what failed, and what changed in the book behind us.", adminOnly: true },
] as const;

export function AdminReportGate({ children }: { children: ReactNode }) {
  const profile = useAccessProfile();
  if (profile.isPending) return <Skeleton className="h-72 w-full" />;
  if (profile.data?.isAdmin !== true) {
    return (
      <p className="text-sm text-muted-foreground">
        Administrator access required
      </p>
    );
  }
  return children;
}
