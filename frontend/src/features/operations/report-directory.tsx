"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { REPORT_PAGES } from "./reports-nav";
import { ReportHeader, useReportYear } from "./reports-sections";

const GROUP_META = {
  outcomes: {
    title: "Outcomes",
    description: "Colony survival and honey yield across seasons.",
    hrefs: ["/insights/survival", "/insights/yield"],
  },
  finance: {
    title: "Finance",
    description: "Costs, revenue, margins, and profitability.",
    hrefs: [
      "/insights/economics",
      "/insights/profitability",
      "/sales/expenses",
    ],
  },
  sales: {
    title: "Sales & planning",
    description: "Bottling priorities, customers, and wholesale follow-up.",
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
        title={meta.title}
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
                  href={`${page.href}?year=${year}`}
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
