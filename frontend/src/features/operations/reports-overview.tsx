"use client";

/** `/reports` index: headline numbers plus a map of the report sections. */

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";

import { REPORT_SECTIONS } from "./reports-nav";
import {
  ReportHeader,
  ReportHighlights,
  useReportYear,
} from "./reports-sections";

export function ReportsOverview() {
  const [year, setYear] = useReportYear();
  const sections = REPORT_SECTIONS.filter(
    (section) => section.href !== "/reports",
  );

  return (
    <div className="grid gap-6">
      <ReportHeader
        title="Reports"
        description="One home for survival, yield and money: revenue, expenses, profitability and bottling plans."
        year={year}
        onYearChange={setYear}
      />

      <ReportHighlights year={year} />

      <ul className="grid gap-3 sm:grid-cols-2">
        {sections.map((section) => (
          <li key={section.href}>
            <Card className="h-full transition-colors hover:border-primary/50">
              <CardContent className="p-4">
                <Link
                  href={`${section.href}?year=${year}`}
                  className="flex items-start justify-between gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span>
                    <span className="block font-medium">{section.label}</span>
                    <span className="mt-0.5 block text-sm text-muted-foreground">
                      {section.description}
                    </span>
                  </span>
                  <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
                </Link>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      <p className="text-xs text-muted-foreground">
        Revenue on these reports is <strong>invoiced</strong> — order totals,
        unpaid orders included. Collected amounts appear on the sales list and
        on market-day reconciliation.
      </p>
    </div>
  );
}
