"use client";

import * as React from "react";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { Award, ChartNoAxesCombined } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DataGrid,
  type DataGridColumnMeta,
} from "@/components/ui/data-grid";
import { Skeleton } from "@/components/ui/skeleton";

import { useQueenPerformance, useQueens, type QueenPerformance } from "./api";
import { useUnits } from "@/lib/use-units";

function scoreTone(score: number) {
  if (score >= 80) return "text-emerald-700 dark:text-emerald-400";
  if (score >= 60) return "text-amber-700 dark:text-amber-400";
  return "text-muted-foreground";
}

const gridFeatures = tableFeatures({});
const columnHelper = createColumnHelper<typeof gridFeatures, QueenPerformance>();

const rightAligned: DataGridColumnMeta = {
  align: "right",
  cellClassName: "tabular-nums",
};

export function QueenPerformancePanel() {
  const { formatHoney } = useUnits();
  const performance = useQueenPerformance();
  const queens = useQueens();

  const matingById = React.useMemo(
    () => new Map((queens.data ?? []).map((queen) => [queen.id, queen] as const)),
    [queens.data],
  );
  const ranked = React.useMemo(
    () =>
      [...(performance.data?.queens ?? [])]
        .filter((queen) => queen.inspectionCount > 0)
        .sort((a, b) => b.overallScore - a.overallScore),
    [performance.data],
  );

  const columns = React.useMemo(
    () =>
      columnHelper.columns([
        columnHelper.display({
          id: "queen",
          header: "Queen / hive",
          cell: ({ row: { original: queen } }) => (
            <>
              <p className="font-medium">
                {queen.apiaryName && queen.hiveName
                  ? `${queen.apiaryName} · ${queen.hiveName}`
                  : `Queen ${queen.id.slice(0, 8)}`}
              </p>
              <p className="text-xs capitalize text-muted-foreground">
                {queen.status}
              </p>
            </>
          ),
        }),
        columnHelper.display({
          id: "matedAt",
          header: "Mated at",
          meta: {
            cellClassName: "text-muted-foreground",
          } satisfies DataGridColumnMeta,
          cell: ({ row }) =>
            matingById.get(row.original.id)?.matedAtApiaryName ?? "—",
        }),
        columnHelper.display({
          id: "overall",
          header: "Overall",
          meta: rightAligned,
          cell: ({ row: { original: queen } }) => (
            <span
              className={`text-base font-bold ${scoreTone(queen.overallScore)}`}
            >
              {queen.overallScore.toFixed(1)}
            </span>
          ),
        }),
        columnHelper.display({
          id: "brood",
          header: "Brood",
          meta: rightAligned,
          cell: ({ row }) => row.original.broodScore.toFixed(0),
        }),
        columnHelper.display({
          id: "temperament",
          header: "Temperament",
          meta: rightAligned,
          cell: ({ row }) => row.original.temperamentScore.toFixed(0),
        }),
        columnHelper.display({
          id: "yield",
          header: "Yield",
          meta: rightAligned,
          cell: ({ row }) => formatHoney(row.original.yieldPounds),
        }),
        columnHelper.display({
          id: "inspections",
          header: "Inspections",
          meta: rightAligned,
          cell: ({ row }) => row.original.inspectionCount,
        }),
      ]),
    [matingById, formatHoney],
  );

  const table = useTable({
    features: gridFeatures,
    columns,
    data: ranked,
    getRowId: (row) => row.id,
  });

  if (performance.isPending) return <Skeleton className="h-56 rounded-xl" />;
  if (performance.isError || !performance.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Queen performance unavailable</CardTitle>
        </CardHeader>
      </Card>
    );
  }

  const bestLine = [...performance.data.lineages].sort(
    (a, b) => b.averageScore - a.averageScore,
  )[0];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ChartNoAxesCombined className="size-5 text-primary" />
          Queen performance
        </CardTitle>
        <CardDescription>
          Overall score: brood 30%, temperament 25%, honey yield 30%, colony
          survival 15%. More inspections make comparisons more useful.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {bestLine ? (
          <div className="flex items-center gap-3 rounded-lg bg-primary/8 p-3">
            <Award className="size-5 text-primary" />
            <p className="text-sm">
              Best recorded lineage averages{" "}
              <strong>{bestLine.averageScore.toFixed(1)}</strong> across{" "}
              {bestLine.queenCount} queen
              {bestLine.queenCount === 1 ? "" : "s"}.
            </p>
          </div>
        ) : null}
        {ranked.length ? (
          <DataGrid
            table={table}
            aria-label="Queen performance"
            listenOnWindow={false}
          />
        ) : (
          <div className="grid place-items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
            <ChartNoAxesCombined className="size-7 text-muted-foreground" />
            <p className="text-sm font-medium">No scored queens yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Scores come from inspections linked to a queen. Record an
              inspection on a hive with a queen assigned and her ranking shows
              up here.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
