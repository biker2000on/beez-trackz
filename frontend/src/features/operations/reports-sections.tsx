"use client";

/**
 * Report sections for `/reports`, the single home for operational and
 * financial reporting.
 *
 * Each section is its own route (`/reports/survival`, `/reports/yield`, …) so
 * there are no tabs to lose on a back navigation. The season year is held in
 * the `year` search param, so it survives moving between sections and is
 * shareable.
 */

import Link from "next/link";
import { DollarSign, HeartPulse, Scale, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/features/hives/lib";
import { formatLbs, formatMoney } from "@/features/honey/format";
import { useNumberParam } from "@/lib/url-state";
import {
  miteDisplay,
  useEconomicsReport,
  useSurvivalReport,
  useVarroaFleet,
  useYieldReport,
  type SurvivalGroup,
} from "./hooks";
import { METHOD_LABELS } from "./varroa-panel";

export function currentYear(): number {
  return new Date().getFullYear();
}

/** Season year from the `year` search param, shared across report sections. */
export function useReportYear(fallback = currentYear()) {
  return useNumberParam("year", fallback);
}

export function ReportYearPicker({
  year,
  onYearChange,
}: {
  year: number;
  onYearChange: (year: number) => void;
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor="report-year" className="text-xs">
        Season year
      </Label>
      <Input
        id="report-year"
        type="number"
        min="2000"
        max="2200"
        className="w-28"
        value={year}
        onChange={(event) => onYearChange(Number(event.target.value))}
      />
    </div>
  );
}

export function ReportHeader({
  title,
  description,
  year,
  onYearChange,
}: {
  title: string;
  description: string;
  year?: number;
  onYearChange?: (year: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {year != null && onYearChange != null && (
        <ReportYearPicker year={year} onYearChange={onYearChange} />
      )}
    </div>
  );
}

/** Headline numbers shown on the `/reports` index. */
export function ReportHighlights({ year }: { year: number }) {
  const survival = useSurvivalReport(year);
  const yields = useYieldReport(year);
  const economics = useEconomicsReport(year);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <ReportStat
        label="Winter survival"
        value={survival.data ? `${survival.data.survivalRate.toFixed(0)}%` : undefined}
        detail={survival.data ? `${survival.data.survived}/${survival.data.enteredWinter} colonies` : undefined}
        icon={HeartPulse}
        loading={survival.isPending}
      />
      <ReportStat
        label="Honey harvested"
        value={yields.data ? formatLbs(yields.data.totalPounds) : undefined}
        detail={`${year} harvest`}
        icon={Scale}
        loading={yields.isPending}
      />
      <ReportStat
        label="Top hive"
        value={yields.data?.byHive[0]?.hiveName ?? "—"}
        detail={yields.data?.byHive[0] ? formatLbs(yields.data.byHive[0].pounds) : "No harvests"}
        icon={TrendingUp}
        loading={yields.isPending}
      />
      <ReportStat
        label="Apiary margin"
        value={economics.data ? formatMoney(economics.data.apiaries.reduce((sum, row) => sum + row.margin, 0)) : undefined}
        detail="Invoiced revenue allocated by yield"
        icon={DollarSign}
        loading={economics.isPending}
      />
    </div>
  );
}

/** Apiary-wide varroa standing: hives over the action threshold first. */
export function VarroaFleetSection() {
  const fleet = useVarroaFleet();
  if (fleet.isPending) return <Skeleton className="h-40" />;
  if (!fleet.data) return <ErrorText />;
  const rows = [...fleet.data.hives]
    .filter((row) => row.lastCount)
    .sort((a, b) => {
      if (a.overThreshold !== b.overThreshold) return a.overThreshold ? -1 : 1;
      return (b.lastCount?.date ?? "").localeCompare(a.lastCount?.date ?? "");
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Varroa across the fleet</CardTitle>
        <p className="text-sm text-muted-foreground">
          {fleet.data.overThresholdCount === 0
            ? "No hives over the action level"
            : `${fleet.data.overThresholdCount} ${fleet.data.overThresholdCount === 1 ? "hive" : "hives"} over the action level`}
          {" · "}action at {fleet.data.thresholdPer100}/100 bees or {fleet.data.thresholdPerDay}/day
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">No mite counts recorded yet.</p>
        ) : (
          <Table>
            <TableHeader><TableRow><TableHead>Hive</TableHead><TableHead>Apiary</TableHead><TableHead className="text-right">Latest</TableHead><TableHead>Method</TableHead><TableHead>Date</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {rows.map((row) => {
                const latest = row.lastCount!;
                const display = miteDisplay(latest);
                return (
                  <TableRow key={row.hiveId}>
                    <TableCell className="font-medium">
                      <Link href={`/hives/${row.hiveId}?tab=health`} className="hover:underline">{row.hiveName}</Link>
                    </TableCell>
                    <TableCell>{row.apiaryName}</TableCell>
                    <TableCell className="text-right tabular-nums">{display ? display.label : `${latest.mitesCount} mites`}</TableCell>
                    <TableCell>{METHOD_LABELS[latest.method] ?? latest.method}</TableCell>
                    <TableCell>{formatDate(latest.date)}</TableCell>
                    <TableCell className="text-right">
                      {row.overThreshold && <Badge variant="destructive">Over threshold</Badge>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function SurvivalReport({ year }: { year: number }) {
  const survival = useSurvivalReport(year);
  if (survival.isPending) return <Skeleton className="h-64" />;
  if (!survival.data) return <ErrorText />;
  return (
    <div className="grid gap-5">
      <SurvivalTable title="By apiary" rows={survival.data.byApiary} />
      <SurvivalTable title="By stand position" rows={survival.data.byStand} />
      <SurvivalTable title="By queen line" rows={survival.data.byQueenLine} />
    </div>
  );
}

export function YieldReport({ year }: { year: number }) {
  const yields = useYieldReport(year);
  if (yields.isPending) return <Skeleton className="h-64" />;
  if (!yields.data) return <ErrorText />;
  const byYear = yields.data.byYear;
  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader><CardTitle className="text-base">Hive leaderboard</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow><TableHead>Hive</TableHead><TableHead>Apiary</TableHead><TableHead className="text-right">Honey</TableHead></TableRow></TableHeader>
            <TableBody>
              {yields.data.byHive.map((row) => (
                <TableRow key={row.hiveId}>
                  <TableCell className="font-medium">{row.hiveName}</TableCell>
                  <TableCell>{row.apiaryName}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatLbs(row.pounds)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Year over year</CardTitle></CardHeader>
        <CardContent className="flex min-h-44 items-end gap-3">
          {byYear.map((row) => {
            const max = Math.max(1, ...byYear.map((item) => item.pounds));
            return (
              <div key={row.year} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-xs font-medium">{row.pounds.toFixed(1)}</span>
                <div className="w-full max-w-20 rounded-t bg-amber-500/80" style={{ height: `${Math.max(5, (row.pounds / max) * 110)}px` }} />
                <span className="text-xs text-muted-foreground">{row.year}</span>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

export function EconomicsReport({ year }: { year: number }) {
  const economics = useEconomicsReport(year);
  if (economics.isPending) return <Skeleton className="h-64" />;
  if (!economics.data) return <ErrorText />;
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <Table pinFirstColumn>
          <TableHeader><TableRow>
            <TableHead>Apiary</TableHead><TableHead className="text-right">lb/hive</TableHead>
            <TableHead className="text-right">Revenue (invoiced)</TableHead><TableHead className="text-right">Expenses</TableHead>
            <TableHead className="text-right">Margin</TableHead><TableHead className="text-right">Feed/colony</TableHead>
            <TableHead className="text-right">Treatment/colony</TableHead>
            <TableHead className="text-right">Winter survival</TableHead>
            <TableHead className="text-right">Splits surviving</TableHead>
            <TableHead className="text-right">Introduced queens active</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {economics.data.apiaries.map((row) => (
              <TableRow key={row.apiaryId}>
                <TableCell className="font-medium">{row.apiaryName}</TableCell>
                <TableCell className="text-right">{row.poundsPerHive.toFixed(1)}</TableCell>
                <TableCell className="text-right">{formatMoney(row.revenueAllocated)}</TableCell>
                <TableCell className="text-right">{formatMoney(row.expenses)}</TableCell>
                <TableCell className="text-right font-medium">{formatMoney(row.margin)}</TableCell>
                <TableCell className="text-right">{formatMoney(row.feedCostPerColony)}</TableCell>
                <TableCell className="text-right">{formatMoney(row.treatmentCostPerColony)}</TableCell>
                <TableCell className="text-right">{row.survivedWinter}/{row.enteredWinter} ({row.winterSurvivalRate.toFixed(0)}%)</TableCell>
                <TableCell className="text-right">{row.splitChildrenSurviving}/{row.splitsCreated}</TableCell>
                <TableCell className="text-right">{row.introducedQueensActive}/{row.queensIntroduced}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ReportStat({
  label, value, detail, icon: Icon, loading,
}: {
  label: string; value?: string; detail?: string; icon: typeof HeartPulse; loading: boolean;
}) {
  return (
    <Card><CardContent className="p-4">
      <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"><Icon className="size-4" />{label}</p>
      {loading || value == null ? <Skeleton className="mt-2 h-8 w-24" /> : <p className="mt-1 text-2xl font-bold">{value}</p>}
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
    </CardContent></Card>
  );
}

function SurvivalTable({ title, rows }: { title: string; rows: SurvivalGroup[] }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Group</TableHead><TableHead className="text-right">Entered winter</TableHead><TableHead className="text-right">Survived</TableHead><TableHead className="text-right">Rate</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.map((row) => <TableRow key={row.key}><TableCell className="font-medium">{row.label}</TableCell><TableCell className="text-right">{row.enteredWinter}</TableCell><TableCell className="text-right">{row.survived}</TableCell><TableCell className="text-right font-semibold">{row.survivalRate.toFixed(0)}%</TableCell></TableRow>)}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ErrorText() {
  return <p className="py-8 text-center text-sm text-muted-foreground">Could not load this report.</p>;
}
