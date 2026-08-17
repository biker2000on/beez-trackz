"use client";

/**
 * Three-group section menu for report detail pages. The report home is the
 * directory and deliberately has no duplicate strip.
 *
 * Links carry the current `year` search param forward so switching sections
 * keeps the season you are looking at.
 */

import type { ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { SectionNav } from "@/components/shell/section-nav";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccessProfile } from "@/features/access/api";

export const REPORT_PAGES = [
  { href: "/reports", label: "Overview", description: "Headline numbers for the season." },
  { href: "/reports/survival", label: "Winter survival", description: "Colonies through winter, by apiary, stand and queen line." },
  { href: "/reports/yield", label: "Honey yield", description: "Hive leaderboard and year-over-year harvest weight." },
  { href: "/reports/economics", label: "Apiary economics", description: "Cost and margin per apiary, allocated by yield.", adminOnly: true },
  { href: "/reports/profitability", label: "Profitability", description: "Revenue, expenses, break-even prices and margins.", adminOnly: true },
  { href: "/reports/expenses", label: "Expenses", description: "Everything spent this season, assignable to lots and hives.", adminOnly: true },
  { href: "/reports/bottling", label: "Bottle next", description: "What to bottle next from recent demand.", adminOnly: true },
  { href: "/reports/customers", label: "Customers & wholesale", description: "Customer list, reorder reminders and wholesale price lists.", adminOnly: true },
] as const;

export const REPORT_GROUPS = [
  {
    href: "/reports/outcomes",
    label: "Outcomes",
    matches: ["/reports/survival", "/reports/yield"],
  },
  {
    href: "/reports/finance",
    label: "Finance",
    adminOnly: true,
    matches: [
      "/reports/economics",
      "/reports/profitability",
      "/reports/expenses",
    ],
  },
  {
    href: "/reports/sales-planning",
    label: "Sales & planning",
    adminOnly: true,
    matches: ["/reports/bottling", "/reports/customers"],
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
  if (pathname === "/reports") return null;

  return (
    <SectionNav
      label="Report sections"
      sections={groups}
      mobileSections={pages}
      mobileRootHref="/reports"
      rootHref="/reports/outcomes"
      pathname={pathname}
      hrefSuffix={year ? `?year=${encodeURIComponent(year)}` : ""}
    />
  );
}
