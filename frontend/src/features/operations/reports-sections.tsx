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

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { DollarSign, HeartPulse, Scale, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
} from "@/components/ui/data-grid";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/features/hives/lib";
import { formatLbs, formatMoney } from "@/features/honey/format";
import { useNumberParam } from "@/lib/url-state";
import {
  miteDisplay,
  useEconomicsReport,
  useSurvivalReport,
  useVarroaFleet,
  useYieldReport,
  type EconomicsReport as EconomicsReportData,
  type SurvivalGroup,
  type VarroaFleetHive,
  type YieldReport as YieldReportData,
} from "./hooks";
import { METHOD_LABELS } from "./varroa-panel";

type YieldHiveRow = YieldReportData["byHive"][number];
type EconomicsApiaryRow = EconomicsReportData["apiaries"][number];

const gridFeatures = tableFeatures({});
const varroaColumnHelper = createColumnHelper<
  typeof gridFeatures,
  VarroaFleetHive
>();
const survivalColumnHelper = createColumnHelper<
  typeof gridFeatures,
  SurvivalGroup
>();
const yieldColumnHelper = createColumnHelper<typeof gridFeatures, YieldHiveRow>();
const economicsColumnHelper = createColumnHelper<
  typeof gridFeatures,
  EconomicsApiaryRow
>();

const rightAligned: DataGridColumnMeta = {
  align: "right",
  cellClassName: "tabular-nums",
};

/**
 * The DataGrid table has no `data-pin-first-column` hook into globals.css, so
 * the first column pins itself with the same sticky + card background + 1px
 * edge the old `<Table pinFirstColumn>` styling produced.
 */
const pinnedFirstColumn =
  "sticky left-0 z-[1] bg-card after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border";

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
  if (!fleet.data || !Array.isArray(fleet.data.hives)) return <ErrorText />;
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
        <VarroaFleetGrid hives={fleet.data.hives} />
      </CardContent>
    </Card>
  );
}

function VarroaFleetGrid({ hives }: { hives: VarroaFleetHive[] }) {
  const router = useRouter();

  const rows = React.useMemo(
    () =>
      [...hives]
        .filter((row) => row.lastCount)
        .sort((a, b) => {
          if (a.overThreshold !== b.overThreshold)
            return a.overThreshold ? -1 : 1;
          return (b.lastCount?.date ?? "").localeCompare(
            a.lastCount?.date ?? "",
          );
        }),
    [hives],
  );

  const columns = React.useMemo(
    () =>
      varroaColumnHelper.columns([
        varroaColumnHelper.display({
          id: "hive",
          header: "Hive",
          meta: { cellClassName: "font-medium" } satisfies DataGridColumnMeta,
          cell: ({ row }) => (
            <DataGridCellAction>
              <Link
                href={`/hives/${row.original.hiveId}?tab=health`}
                className="hover:underline"
              >
                {row.original.hiveName}
              </Link>
            </DataGridCellAction>
          ),
        }),
        varroaColumnHelper.display({
          id: "apiary",
          header: "Apiary",
          cell: ({ row }) => row.original.apiaryName,
        }),
        varroaColumnHelper.display({
          id: "latest",
          header: "Latest",
          meta: rightAligned,
          cell: ({ row }) => {
            const latest = row.original.lastCount!;
            const display = miteDisplay(latest);
            return display ? display.label : `${latest.mitesCount} mites`;
          },
        }),
        varroaColumnHelper.display({
          id: "method",
          header: "Method",
          cell: ({ row }) => {
            const latest = row.original.lastCount!;
            return METHOD_LABELS[latest.method] ?? latest.method;
          },
        }),
        varroaColumnHelper.display({
          id: "date",
          header: "Date",
          cell: ({ row }) => formatDate(row.original.lastCount!.date),
        }),
        varroaColumnHelper.display({
          id: "threshold",
          header: "",
          meta: { align: "right" } satisfies DataGridColumnMeta,
          cell: ({ row }) =>
            row.original.overThreshold && (
              <Badge variant="destructive">Over threshold</Badge>
            ),
        }),
      ]),
    [],
  );

  const table = useTable({
    features: gridFeatures,
    columns,
    data: rows,
    getRowId: (row) => row.hiveId,
  });

  if (rows.length === 0) {
    return (
      <p className="px-4 pb-4 text-sm text-muted-foreground">No mite counts recorded yet.</p>
    );
  }
  return (
    <DataGrid
      table={table}
      aria-label="Varroa across the fleet"
      listenOnWindow={false}
      onRowActivate={(row) => router.push(`/hives/${row.hiveId}?tab=health`)}
    />
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
          <YieldLeaderboardGrid rows={yields.data.byHive} />
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
        <EconomicsGrid rows={economics.data.apiaries} />
      </CardContent>
    </Card>
  );
}

function YieldLeaderboardGrid({ rows }: { rows: YieldHiveRow[] }) {
  const columns = React.useMemo(
    () =>
      yieldColumnHelper.columns([
        yieldColumnHelper.display({
          id: "hive",
          header: "Hive",
          meta: { cellClassName: "font-medium" } satisfies DataGridColumnMeta,
          cell: ({ row }) => row.original.hiveName,
        }),
        yieldColumnHelper.display({
          id: "apiary",
          header: "Apiary",
          cell: ({ row }) => row.original.apiaryName,
        }),
        yieldColumnHelper.display({
          id: "honey",
          header: "Honey",
          meta: rightAligned,
          cell: ({ row }) => formatLbs(row.original.pounds),
        }),
      ]),
    [],
  );

  const table = useTable({
    features: gridFeatures,
    columns,
    data: rows,
    getRowId: (row) => row.hiveId,
  });

  return (
    <DataGrid
      table={table}
      aria-label="Hive leaderboard"
      listenOnWindow={false}
    />
  );
}

function EconomicsGrid({ rows }: { rows: EconomicsApiaryRow[] }) {
  const columns = React.useMemo(
    () =>
      economicsColumnHelper.columns([
        economicsColumnHelper.display({
          id: "apiary",
          header: "Apiary",
          meta: {
            headClassName: pinnedFirstColumn,
            cellClassName: `font-medium ${pinnedFirstColumn}`,
          } satisfies DataGridColumnMeta,
          cell: ({ row }) => row.original.apiaryName,
        }),
        economicsColumnHelper.display({
          id: "poundsPerHive",
          header: "lb/hive",
          meta: rightAligned,
          cell: ({ row }) => row.original.poundsPerHive.toFixed(1),
        }),
        economicsColumnHelper.display({
          id: "revenue",
          header: "Revenue (invoiced)",
          meta: rightAligned,
          cell: ({ row }) => formatMoney(row.original.revenueAllocated),
        }),
        economicsColumnHelper.display({
          id: "expenses",
          header: "Expenses",
          meta: rightAligned,
          cell: ({ row }) => formatMoney(row.original.expenses),
        }),
        economicsColumnHelper.display({
          id: "margin",
          header: "Margin",
          meta: {
            align: "right",
            cellClassName: "tabular-nums font-medium",
          } satisfies DataGridColumnMeta,
          cell: ({ row }) => formatMoney(row.original.margin),
        }),
        economicsColumnHelper.display({
          id: "feedPerColony",
          header: "Feed/colony",
          meta: rightAligned,
          cell: ({ row }) => formatMoney(row.original.feedCostPerColony),
        }),
        economicsColumnHelper.display({
          id: "treatmentPerColony",
          header: "Treatment/colony",
          meta: rightAligned,
          cell: ({ row }) => formatMoney(row.original.treatmentCostPerColony),
        }),
        economicsColumnHelper.display({
          id: "winterSurvival",
          header: "Winter survival",
          meta: rightAligned,
          cell: ({ row }) => (
            <>
              {row.original.survivedWinter}/{row.original.enteredWinter} (
              {row.original.winterSurvivalRate.toFixed(0)}%)
            </>
          ),
        }),
        economicsColumnHelper.display({
          id: "splitsSurviving",
          header: "Splits surviving",
          meta: rightAligned,
          cell: ({ row }) => (
            <>
              {row.original.splitChildrenSurviving}/{row.original.splitsCreated}
            </>
          ),
        }),
        economicsColumnHelper.display({
          id: "queensActive",
          header: "Introduced queens active",
          meta: rightAligned,
          cell: ({ row }) => (
            <>
              {row.original.introducedQueensActive}/
              {row.original.queensIntroduced}
            </>
          ),
        }),
      ]),
    [],
  );

  const table = useTable({
    features: gridFeatures,
    columns,
    data: rows,
    getRowId: (row) => row.apiaryId,
  });

  return (
    <DataGrid
      table={table}
      aria-label="Apiary economics"
      listenOnWindow={false}
    />
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
  const columns = React.useMemo(
    () =>
      survivalColumnHelper.columns([
        survivalColumnHelper.display({
          id: "group",
          header: "Group",
          meta: { cellClassName: "font-medium" } satisfies DataGridColumnMeta,
          cell: ({ row }) => row.original.label,
        }),
        survivalColumnHelper.display({
          id: "enteredWinter",
          header: "Entered winter",
          meta: rightAligned,
          cell: ({ row }) => row.original.enteredWinter,
        }),
        survivalColumnHelper.display({
          id: "survived",
          header: "Survived",
          meta: rightAligned,
          cell: ({ row }) => row.original.survived,
        }),
        survivalColumnHelper.display({
          id: "rate",
          header: "Rate",
          meta: {
            align: "right",
            cellClassName: "tabular-nums font-semibold",
          } satisfies DataGridColumnMeta,
          cell: ({ row }) => `${row.original.survivalRate.toFixed(0)}%`,
        }),
      ]),
    [],
  );

  const table = useTable({
    features: gridFeatures,
    columns,
    data: rows,
    getRowId: (row) => row.key,
  });

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="p-0">
        <DataGrid table={table} aria-label={title} listenOnWindow={false} />
      </CardContent>
    </Card>
  );
}

function ErrorText() {
  return <p className="py-8 text-center text-sm text-muted-foreground">Could not load this report.</p>;
}
