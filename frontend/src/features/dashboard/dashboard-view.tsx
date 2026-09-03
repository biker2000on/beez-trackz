"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { useAccessProfile } from "@/features/access/api";

import { FrameShortageWidget } from "./frame-shortage-widget";
import { HoneySummaryWidget } from "./honey-summary-widget";

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

/**
 * Where the work went. The dashboard used to assemble the field slice itself
 * (`useFieldWork`) and split it into two widgets; Today reads that split from
 * the server now, so the dashboard links to it rather than competing with it.
 */
const WORK = [
  { href: "/today", label: "Today — what needs doing" },
  { href: "/yard/queue", label: "Yard queue — the Saturday walk" },
  { href: "/today/recommendations", label: "Recommendations and triage history" },
];

const REPORTS = [
  { href: "/reports", label: "Reports and analytics" },
  { href: "/yard", label: "Hive and apiary status" },
];

/**
 * What is left of the dashboard after the field slice moved to `/today`.
 *
 * §4.1 of the 2026-09-03 design relocates all five status and history
 * widgets. Two of them have a home in this wave — hive overview and recent
 * inspections are on `/yard` — and feeding status is now work items on Today.
 * Frame shortage and honey summary belong to `/equipment` and `/production`,
 * which wave 5 creates; they stay here until then rather than being deleted
 * out from under the operator.
 */
export function DashboardView() {
  const access = useAccessProfile();
  const isAdmin = access.data?.isAdmin === true;

  return (
    <div className="grid gap-8">
      <div className="grid gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          The work itself lives on Today — one list, ordered by the server,
          with the evidence behind every item.
        </p>
      </div>

      <section className="grid gap-3">
        <SectionHeading>Work</SectionHeading>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {WORK.map((entry) => (
            <Link
              key={entry.href}
              href={entry.href}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {entry.label}
              <ArrowRight className="size-3.5" />
            </Link>
          ))}
        </div>
      </section>

      {isAdmin ? (
        <section className="grid gap-3">
          <SectionHeading>Equipment and honey</SectionHeading>
          <div className="grid gap-4 sm:grid-cols-2">
            <FrameShortageWidget />
            <HoneySummaryWidget />
          </div>
        </section>
      ) : null}

      <section className="grid gap-3">
        <SectionHeading>Reporting</SectionHeading>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {REPORTS.map((report) => (
            <Link
              key={report.href}
              href={report.href}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {report.label}
              <ArrowRight className="size-3.5" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
