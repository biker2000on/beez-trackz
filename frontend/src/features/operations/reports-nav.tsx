"use client";

/**
 * Three-group section menu for Insights detail pages. The Insights home is
 * the directory and deliberately has no duplicate strip.
 *
 * Links carry the current `year` search param forward so switching sections
 * keeps the season you are looking at.
 *
 * The compliance packet and the GnuCash reconciliation report are Insights'
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
import { usePathname, useSearchParams } from "next/navigation";

import { SectionNav } from "@/components/shell/section-nav";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccessProfile } from "@/features/access/api";

export const REPORT_PAGES = [
  { href: "/insights", label: "Overview", description: "Headline numbers for the season." },
  { href: "/insights/survival", label: "Winter survival", description: "Colonies through winter, by apiary, stand and queen line." },
  { href: "/insights/yield", label: "Honey yield", description: "Hive leaderboard and year-over-year harvest weight." },
  { href: "/insights/economics", label: "Apiary economics", description: "Cost and margin per apiary, allocated by yield.", adminOnly: true },
  { href: "/insights/profitability", label: "Profitability", description: "Revenue, expenses, break-even prices and margins.", adminOnly: true },
  { href: "/sales/expenses", label: "Expenses", description: "Everything spent this season, assignable to lots and hives. Edited in Sales.", adminOnly: true },
  { href: "/insights/bottling", label: "Bottle next", description: "What to bottle next from recent demand.", adminOnly: true },
  { href: "/sales/customers", label: "Customers & wholesale", description: "Customer list, reorder reminders and wholesale price lists. Edited in Sales.", adminOnly: true },
  { href: "/insights/compliance", label: "Compliance packet", description: "Hives, treatments, lots, sales and withdrawal windows, in one export.", adminOnly: true },
  { href: "/insights/reconciliation", label: "GnuCash reconciliation", description: "What the feed pushed, what failed, and what changed in the book behind us.", adminOnly: true },
] as const;

export const REPORT_GROUPS = [
  {
    href: "/insights/outcomes",
    label: "Outcomes",
    matches: ["/insights/survival", "/insights/yield"],
  },
  {
    href: "/insights/finance",
    label: "Finance",
    adminOnly: true,
    matches: ["/insights/economics", "/insights/profitability"],
  },
  {
    href: "/insights/sales-planning",
    label: "Sales & planning",
    adminOnly: true,
    matches: ["/insights/bottling"],
  },
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

export function ReportsSectionNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const year = searchParams.get("year");
  const isAdmin = useAccessProfile().data?.isAdmin === true;
  const groups = REPORT_GROUPS.filter(
    (group) => isAdmin || !("adminOnly" in group && group.adminOnly),
  );
  const pages = REPORT_PAGES.filter(
    (page) => isAdmin || !("adminOnly" in page && page.adminOnly),
  );

  // The report home is already a visual directory. Repeating every report in
  // a pill strip above those cards was redundant and clipped at tablet width.
  if (pathname === "/insights") return null;

  return (
    <SectionNav
      label="Insights sections"
      sections={groups}
      mobileSections={pages}
      mobileRootHref="/insights"
      rootHref="/insights/outcomes"
      pathname={pathname}
      hrefSuffix={year ? `?year=${encodeURIComponent(year)}` : ""}
    />
  );
}
