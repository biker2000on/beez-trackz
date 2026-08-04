"use client";

/**
 * Section menu for `/reports`. Replaces both the old operations tab strip and
 * the four nested Business tabs that used to live inside `/harvest`.
 *
 * Links carry the current `year` search param forward so switching sections
 * keeps the season you are looking at.
 */

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { cn } from "@/lib/utils";

export const REPORT_SECTIONS = [
  { href: "/reports", label: "Overview", description: "Headline numbers for the season." },
  { href: "/reports/survival", label: "Winter survival", description: "Colonies through winter, by apiary, stand and queen line." },
  { href: "/reports/yield", label: "Honey yield", description: "Hive leaderboard and year-over-year harvest weight." },
  { href: "/reports/economics", label: "Apiary economics", description: "Cost and margin per apiary, allocated by yield." },
  { href: "/reports/profitability", label: "Profitability", description: "Revenue, expenses, break-even prices and margins." },
  { href: "/reports/expenses", label: "Expenses", description: "Everything spent this season, assignable to lots and hives." },
  { href: "/reports/bottling", label: "Bottle next", description: "What to bottle next from recent demand." },
  { href: "/reports/customers", label: "Customers & wholesale", description: "Customer list, reorder reminders and wholesale price lists." },
] as const;

export function ReportsSectionNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const year = searchParams.get("year");
  const suffix = year ? `?year=${encodeURIComponent(year)}` : "";

  return (
    <nav
      aria-label="Report sections"
      className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0"
    >
      <ul className="inline-flex min-w-max items-center gap-1 rounded-lg bg-muted p-1">
        {REPORT_SECTIONS.map((section) => {
          const active =
            section.href === "/reports"
              ? pathname === "/reports"
              : pathname.startsWith(section.href);
          return (
            <li key={section.href}>
              <Link
                href={`${section.href}${suffix}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
