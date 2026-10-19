"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { REPORT_PAGES } from "./reports-nav";
import { ReportHeader, seasonHref, useReportYear } from "./reports-sections";

const GROUP_META = {
  outcomes: {
    description:
      "Two reports: Winter survival answers which hives made it through and why; Honey yield answers which hives and apiaries produced the most.",
    hrefs: ["/insights/survival", "/insights/yield"],
  },
  finance: {
    description:
      "Apiary economics answers what each apiary costs and earns; Profitability answers whether the operation makes money and at what price; Expenses is where the costs are entered.",
    hrefs: [
      "/insights/economics",
      "/insights/profitability",
      "/sales/expenses",
    ],
  },
  sales: {
    description:
      "Bottle next answers what to bottle from what sold recently; Customers answers who is due a reorder and what they pay.",
    hrefs: ["/insights/bottling", "/sales/customers"],
  },
} as const;

export type ReportGroup = keyof typeof GROUP_META;

export function ReportDirectory({ group }: { group: ReportGroup }) {
  const [year, setYear] = useReportYear();
  const meta = GROUP_META[group];
  const groupHrefs: readonly string[] = meta.hrefs;
  const pages = REPORT_PAGES.filter((page) => groupHrefs.includes(page.href));

  return (
    <div className="grid gap-6">
      <ReportHeader
        description={meta.description}
        year={year}
        onYearChange={setYear}
      />
      <ul className="grid gap-3 sm:grid-cols-2">
        {pages.map((page) => (
          <li key={page.href}>
            <Card className="h-full transition-colors hover:border-primary/50">
              <CardContent className="p-4">
                <Link
                  href={seasonHref(page.href, year)}
                  className="flex items-start justify-between gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span>
                    <span className="block font-medium">{page.label}</span>
                    <span className="mt-0.5 block text-sm text-muted-foreground">
                      {page.description}
                    </span>
                  </span>
                  <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
                </Link>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
