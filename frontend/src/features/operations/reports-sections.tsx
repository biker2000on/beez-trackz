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
import { useRouter, useSearchParams } from "next/navigation";
import { useQueries } from "@tanstack/react-query";
import {
  createColumnHelper,
  useTable,
} from "@tanstack/react-table";
import { DollarSign, HeartPulse, Scale, TrendingUp } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
  dataGridFeatures,
} from "@/components/ui/data-grid";
import { YearSelect } from "@/components/ui/year-select";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { type Apiary } from "@/features/apiaries/hooks";
import type { CanvasLayout } from "@/features/canvas/lib/types";
import { formatDate } from "@/features/hives/lib";
import { formatLbs, formatMoney } from "@/features/honey/format";
import { useQueens } from "@/features/queens/api";
import { api } from "@/lib/api";
import { useSetSearchParams } from "@/lib/url-state";
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
import {
  resolveQueenLineRows,
  resolveStandRows,
  type StandRef,
} from "./survival-labels";
import { METHOD_LABELS } from "./varroa-panel";

type YieldHiveRow = YieldReportData["byHive"][number];
type EconomicsApiaryRow = EconomicsReportData["apiaries"][number];

const gridFeatures = dataGridFeatures;
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

export function currentYear(): number {
  return new Date().getFullYear();
}

/**
 * The season for the whole Insights area, held in the `season` search param
 * so it survives moving between the hub, its sub-hubs and every report. One
 * default for all of them — the current year — so the hub's headline numbers
 * and the report a tile opens never disagree about which season they show.
 * `year` is read as a legacy alias so shared links from before the rename
 * still open on their season; writes go to `season`.
 */
export function useReportYear(
  fallback = currentYear(),
): [number, (next: number) => void] {
  const params = useSearchParams();
  const setParams = useSetSearchParams();
  const raw = params.get("season") ?? params.get("year");
  const parsed = Number(raw);
  const value = raw != null && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  const set = React.useCallback(
    (next: number) =>
      // The legacy key is dropped on write so a link never carries two seasons.
      setParams({ season: next === fallback ? null : String(next), year: null }),
    [fallback, setParams],
  );
  return [value, set];
}

/** `href` with the season carried along, for links inside Insights. */
export function seasonHref(href: string, season: number): string {
  return `${href}${href.includes("?") ? "&" : "?"}season=${season}`;
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
      <YearSelect
        id="report-year"
        value={year}
        onValueChange={(next) => {
          if (next != null) onYearChange(next);
        }}
      />
    </div>
  );
}

export function ReportHeader({
  description,
  year,
  onYearChange,
}: {
  description: string;
  year?: number;
  onYearChange?: (year: number) => void;
}) {
  return (
    <PageHeader
      subtitle={description}
      actions={
        year != null && onYearChange != null ? (
          <ReportYearPicker year={year} onYearChange={onYearChange} />
        ) : null
      }
    />
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
        detail={survival.data ? `${survival.data.survived}/${survival.data.enteredWinter} hives` : undefined}
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
        <CardTitle className="text-base">Varroa across every hive</CardTitle>
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
        varroaColumnHelper.accessor((r) => r.hiveName, {
          id: "hive",
          header: "Hive",
          meta: { cellClassName: "font-medium" } satisfies DataGridColumnMeta,
          cell: ({ row }) => (
            <DataGridCellAction>
              <Link
                href={`/yard/hives/${row.original.hiveId}?tab=health`}
                className="hover:underline"
              >
                {row.original.hiveName}
              </Link>
            </DataGridCellAction>
          ),
        }),
        varroaColumnHelper.accessor((r) => r.apiaryName, {
          id: "apiary",
          header: "Apiary",
          cell: ({ row }) => row.original.apiaryName,
        }),
        varroaColumnHelper.accessor((r) => r.lastCount?.mitesCount, { sortUndefined: "last",
          id: "latest",
          header: "Latest",
          meta: rightAligned,
          cell: ({ row }) => {
            const latest = row.original.lastCount!;
            const display = miteDisplay(latest);
            return display ? display.label : `${latest.mitesCount} mites`;
          },
        }),
        varroaColumnHelper.accessor((r) => (r.lastCount ? (METHOD_LABELS[r.lastCount.method] ?? r.lastCount.method) : undefined), {
          id: "method",
          header: "Method",
          cell: ({ row }) => {
            const latest = row.original.lastCount!;
            return METHOD_LABELS[latest.method] ?? latest.method;
          },
        }),
        varroaColumnHelper.accessor((r) => r.lastCount?.date, { sortUndefined: "last",
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
      aria-label="Varroa across every hive"
      listenOnWindow={false}
      onRowActivate={(row) => router.push(`/yard/hives/${row.hiveId}?tab=health`)}
    />
  );
}

export function SurvivalReport({ year }: { year: number }) {
  const survival = useSurvivalReport(year);
  const queens = useQueens();
  // The stand ids in `byStand` live in each apiary's canvas layout; the
  // report's own `byApiary` says which apiaries to read.
  const apiaryIds = React.useMemo(
    () => (survival.data?.byApiary ?? []).map((row) => row.key),
    [survival.data],
  );
  // `combine` is structurally shared, so `layouts.apiaries` is the same
  // array between renders until a layout actually changes.
  const layouts = useQueries({
    queries: apiaryIds.map((id) => ({
      queryKey: ["apiaries", "detail", id],
      queryFn: () => api.get<Apiary>(`/apiaries/${id}`),
    })),
    combine: (results) => ({
      pending: results.some((query) => query.isPending),
      apiaries: results
        .map((query) => query.data)
        .filter((apiary): apiary is Apiary => apiary != null),
    }),
  });
  const layoutsPending = layouts.pending;
  const layoutData = layouts.apiaries;

  const rows = React.useMemo(() => {
    if (!survival.data) return null;
    const apiaryNames = new Map(
      survival.data.byApiary.map((row) => [row.key, row.label]),
    );
    const standsByApiary = new Map<string, StandRef[]>();
    for (const apiary of layoutData) {
      const stands = (apiary.canvasLayout as CanvasLayout | null)?.stands ?? [];
      standsByApiary.set(
        apiary.id,
        stands.map((stand) => ({ id: stand.id, label: stand.label })),
      );
    }
    return {
      byStand: resolveStandRows(survival.data.byStand, standsByApiary, apiaryNames),
      byQueenLine: resolveQueenLineRows(
        survival.data.byQueenLine,
        queens.data ?? [],
      ),
    };
  }, [survival.data, queens.data, layoutData]);

  if (survival.isPending || queens.isPending || layoutsPending) {
    return <Skeleton className="h-64" />;
  }
  if (!survival.data || !rows) return <ErrorText />;
  return (
    <div className="grid gap-5">
      <SurvivalTable title="By apiary" rows={survival.data.byApiary} />
      <SurvivalTable title="By stand" rows={rows.byStand} />
      <SurvivalTable title="By queen line" rows={rows.byQueenLine} />
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
      <CardContent className="p-0">
        <EconomicsGrid rows={economics.data.apiaries} />
      </CardContent>
    </Card>
  );
}

function YieldLeaderboardGrid({ rows }: { rows: YieldHiveRow[] }) {
  const columns = React.useMemo(
    () =>
      yieldColumnHelper.columns([
        yieldColumnHelper.accessor((r) => r.hiveName, {
          id: "hive",
          header: "Hive",
          meta: { cellClassName: "font-medium" } satisfies DataGridColumnMeta,
          cell: ({ row }) => row.original.hiveName,
        }),
        yieldColumnHelper.accessor((r) => r.apiaryName, {
          id: "apiary",
          header: "Apiary",
          cell: ({ row }) => row.original.apiaryName,
        }),
        yieldColumnHelper.accessor((r) => r.pounds, {
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
        economicsColumnHelper.accessor((r) => r.apiaryName, {
          id: "apiary",
          header: "Apiary",
          meta: {
            cellClassName: "font-medium whitespace-normal",
          } satisfies DataGridColumnMeta,
          cell: ({ row }) => row.original.apiaryName,
        }),
        economicsColumnHelper.accessor((r) => r.poundsPerHive, {
          id: "poundsPerHive",
          header: "lb/hive",
          meta: { ...rightAligned, label: "Pounds per hive" },
          cell: ({ row }) => row.original.poundsPerHive.toFixed(1),
        }),
        economicsColumnHelper.accessor((r) => r.revenueAllocated, {
          id: "revenue",
          header: "Revenue",
          // The page description says revenue is invoiced order totals; the
          // long form rides along as the header tooltip and card label.
          meta: { ...rightAligned, label: "Revenue (invoiced)" },
          cell: ({ row }) => formatMoney(row.original.revenueAllocated),
        }),
        economicsColumnHelper.accessor((r) => r.expenses, {
          id: "expenses",
          header: "Expenses",
          meta: rightAligned,
          cell: ({ row }) => formatMoney(row.original.expenses),
        }),
        economicsColumnHelper.accessor((r) => r.margin, {
          id: "margin",
          header: "Margin",
          meta: {
            align: "right",
            cellClassName: "tabular-nums font-medium",
          } satisfies DataGridColumnMeta,
          cell: ({ row }) => formatMoney(row.original.margin),
        }),
        economicsColumnHelper.accessor((r) => r.feedCostPerColony, {
          id: "feedPerColony",
          header: "Feed / hive",
          meta: {
            ...rightAligned,
            label: "Feed per hive",
            priority: "secondary",
          } satisfies DataGridColumnMeta,
          cell: ({ row }) => formatMoney(row.original.feedCostPerColony),
        }),
        economicsColumnHelper.accessor((r) => r.treatmentCostPerColony, {
          id: "treatmentPerColony",
          header: "Treatment / hive",
          meta: {
            ...rightAligned,
            label: "Treatment per hive",
            priority: "secondary",
          } satisfies DataGridColumnMeta,
          cell: ({ row }) => formatMoney(row.original.treatmentCostPerColony),
        }),
        economicsColumnHelper.accessor((r) => r.winterSurvivalRate, {
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
        economicsColumnHelper.accessor((r) => r.splitChildrenSurviving, {
          id: "splitsSurviving",
          header: "Splits surviving",
          meta: { ...rightAligned, priority: "secondary" } satisfies DataGridColumnMeta,
          cell: ({ row }) => (
            <>
              {row.original.splitChildrenSurviving}/{row.original.splitsCreated}
            </>
          ),
        }),
        economicsColumnHelper.accessor((r) => r.introducedQueensActive, {
          id: "queensActive",
          header: "Queens active",
          meta: {
            ...rightAligned,
            label: "Introduced queens active",
            priority: "secondary",
          } satisfies DataGridColumnMeta,
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
        survivalColumnHelper.accessor((r) => r.label, {
          id: "group",
          header: "Group",
          meta: { cellClassName: "font-medium" } satisfies DataGridColumnMeta,
          cell: ({ row }) => row.original.label,
        }),
        survivalColumnHelper.accessor((r) => r.enteredWinter, {
          id: "enteredWinter",
          header: "Entered winter",
          meta: rightAligned,
          cell: ({ row }) => row.original.enteredWinter,
        }),
        survivalColumnHelper.accessor((r) => r.survived, {
          id: "survived",
          header: "Survived",
          meta: rightAligned,
          cell: ({ row }) => row.original.survived,
        }),
        survivalColumnHelper.accessor((r) => r.survivalRate, {
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
