"use client";

/**
 * One client view per `/reports` sub-route. Each owns its heading and the
 * shared `year` search param; the route files just wrap these in `Suspense`.
 */

import {
  CustomersPanel,
  ExpensesPanel,
  PlanningPanel,
  ProfitabilityPanel,
} from "@/features/commerce/business-reports";

import {
  EconomicsReport,
  ReportHeader,
  SurvivalReport,
  YieldReport,
  currentYear,
  useReportYear,
} from "./reports-sections";

export function SurvivalReportView() {
  // Winter survival is measured over the winter that *ends* in the season
  // year, so the useful default is last year rather than the current one.
  const [year, setYear] = useReportYear(currentYear() - 1);
  return (
    <div className="grid gap-5">
      <ReportHeader
        title="Winter survival"
        description="Colonies that entered and left winter, grouped by apiary, stand position and queen line."
        year={year}
        onYearChange={setYear}
      />
      <SurvivalReport year={year} />
    </div>
  );
}

export function YieldReportView() {
  const [year, setYear] = useReportYear(currentYear() - 1);
  return (
    <div className="grid gap-5">
      <ReportHeader
        title="Honey yield"
        description="Hive leaderboard for the season and total harvest weight year over year."
        year={year}
        onYearChange={setYear}
      />
      <YieldReport year={year} />
    </div>
  );
}

export function EconomicsReportView() {
  const [year, setYear] = useReportYear(currentYear() - 1);
  return (
    <div className="grid gap-5">
      <ReportHeader
        title="Apiary economics"
        description="Cost and margin per apiary. Revenue is invoiced order totals allocated by yield."
        year={year}
        onYearChange={setYear}
      />
      <EconomicsReport year={year} />
    </div>
  );
}

export function ProfitabilityView() {
  const [year, setYear] = useReportYear();
  return (
    <div className="grid gap-5">
      <ReportHeader
        title="Profitability"
        description="Revenue (invoiced), expenses, break-even prices and margin by channel, lot and jar size."
        year={year}
        onYearChange={setYear}
      />
      <ProfitabilityPanel year={year} />
    </div>
  );
}

export function ExpensesView() {
  const [year, setYear] = useReportYear();
  return (
    <div className="grid gap-5">
      <ReportHeader
        title="Expenses"
        description="Everything spent this season, assignable to an apiary, hive or harvest lot."
        year={year}
        onYearChange={setYear}
      />
      <ExpensesPanel year={year} />
    </div>
  );
}

export function BottlingView() {
  return (
    <div className="grid gap-5">
      <ReportHeader
        title="Bottle next"
        description="What to bottle next, projected from recent demand and bulk honey on hand."
      />
      <PlanningPanel />
    </div>
  );
}

export function CustomersView() {
  return (
    <div className="grid gap-5">
      <ReportHeader
        title="Customers & wholesale"
        description="Customer list with reorder reminders, plus wholesale price lists."
      />
      <CustomersPanel />
    </div>
  );
}
