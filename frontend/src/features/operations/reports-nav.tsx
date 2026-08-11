"use client";

/**
 * Three-group section menu for report detail pages. The report home is the
 * directory and deliberately has no duplicate strip.
 *
 * Links carry the current `year` search param forward so switching sections
 * keeps the season you are looking at.
 */

import { usePathname, useSearchParams } from "next/navigation";

import { SectionNav } from "@/components/shell/section-nav";

export const REPORT_PAGES = [
  { href: "/reports", label: "Overview", description: "Headline numbers for the season." },
  { href: "/reports/survival", label: "Winter survival", description: "Colonies through winter, by apiary, stand and queen line." },
  { href: "/reports/yield", label: "Honey yield", description: "Hive leaderboard and year-over-year harvest weight." },
  { href: "/reports/economics", label: "Apiary economics", description: "Cost and margin per apiary, allocated by yield." },
  { href: "/reports/profitability", label: "Profitability", description: "Revenue, expenses, break-even prices and margins." },
  { href: "/reports/expenses", label: "Expenses", description: "Everything spent this season, assignable to lots and hives." },
  { href: "/reports/bottling", label: "Bottle next", description: "What to bottle next from recent demand." },
  { href: "/reports/customers", label: "Customers & wholesale", description: "Customer list, reorder reminders and wholesale price lists." },
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
    matches: [
      "/reports/economics",
      "/reports/profitability",
      "/reports/expenses",
    ],
  },
  {
    href: "/reports/sales-planning",
    label: "Sales & planning",
    matches: ["/reports/bottling", "/reports/customers"],
  },
] as const;

export function ReportsSectionNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const year = searchParams.get("year");

  // The report home is already a visual directory. Repeating every report in
  // a pill strip above those cards was redundant and clipped at tablet width.
  if (pathname === "/reports") return null;

  return (
    <SectionNav
      label="Report sections"
      sections={REPORT_GROUPS}
      rootHref="/reports/outcomes"
      pathname={pathname}
      hrefSuffix={year ? `?year=${encodeURIComponent(year)}` : ""}
    />
  );
}
