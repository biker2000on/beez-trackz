"use client";

/**
 * Loss report: what was damaged, retired, or written off in a period, and what
 * it was worth. Every row comes from the same ledger the stock counts do, so
 * the totals and the event list cannot disagree.
 */

import * as React from "react";
import {
  createColumnHelper,
  useTable,
} from "@tanstack/react-table";
import { TrendingDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DataGrid,
  type DataGridColumnMeta,
  dataGridFeatures,
} from "@/components/ui/data-grid";

import { formatCents, formatDate } from "./format";
import { useLossReport } from "./hooks";
import { LOSS_KIND_LABELS, reasonLabel, type LossReport } from "./types";

/** The first of January this year, as a date-input value. */
function startOfYearISO(): string {
  return `${new Date().getFullYear()}-01-01`;
}

type LossByTypeRow = LossReport["byType"][number];

const gridFeatures = dataGridFeatures;
const columnHelper = createColumnHelper<typeof gridFeatures, LossByTypeRow>();

const rightAligned: DataGridColumnMeta = {
  align: "right",
  cellClassName: "tabular-nums",
};

export function LossReportCard() {
  const [from, setFrom] = React.useState(startOfYearISO);
  const [to, setTo] = React.useState("");
  const report = useLossReport({ from, to });

  const totals = report.data?.totals;
  const hasLosses =
    totals != null &&
    totals.damaged + totals.retired + totals.writtenOff > 0;

  const byType = React.useMemo(
    () => report.data?.byType ?? [],
    [report.data],
  );

  const columns = React.useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor((row) => row.typeName, {
          id: "equipment",
          header: "Equipment",
          meta: { cellClassName: "font-medium" } satisfies DataGridColumnMeta,
          cell: ({ row }) => row.original.typeName,
        }),
        columnHelper.accessor((row) => row.damaged, {
          id: "damaged",
          header: "Damaged",
          meta: rightAligned,
          cell: ({ row }) => row.original.damaged || "—",
        }),
        columnHelper.accessor((row) => row.retired, {
          id: "retired",
          header: "Retired",
          meta: rightAligned,
          cell: ({ row }) => row.original.retired || "—",
        }),
        columnHelper.accessor((row) => row.writtenOff, {
          id: "writtenOff",
          header: "Written off",
          meta: rightAligned,
          cell: ({ row }) => row.original.writtenOff || "—",
        }),
        columnHelper.accessor((row) => row.valueCents, {
          id: "value",
          header: "Value",
          meta: rightAligned,
          cell: ({ row }) => formatCents(row.original.valueCents),
        }),
      ]),
    [],
  );

  const table = useTable({
    features: gridFeatures,
    columns,
    data: byType,
    getRowId: (row) => row.typeId,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingDown className="size-4 text-primary" />
          Losses
        </CardTitle>
        <CardDescription>
          Equipment damaged, retired, or written off — and what it cost you.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="loss-from" className="text-xs">
              From
            </Label>
            <Input
              id="loss-from"
              type="date"
              className="h-8 w-40"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="loss-to" className="text-xs">
              To
            </Label>
            <Input
              id="loss-to"
              type="date"
              className="h-8 w-40"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
          >
            All time
          </Button>
        </div>

        {report.isPending ? (
          <div className="grid gap-2">
            <Skeleton className="h-16" />
            <Skeleton className="h-24" />
          </div>
        ) : report.isError ? (
          <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <p>Could not load the loss report.</p>
            <Button variant="outline" size="sm" onClick={() => report.refetch()}>
              Retry
            </Button>
          </div>
        ) : !hasLosses ? (
          <p className="py-3 text-sm text-muted-foreground">
            No equipment losses recorded in this period.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <LossStat label="Damaged" value={totals.damaged} />
              <LossStat label="Retired" value={totals.retired} />
              <LossStat label="Written off" value={totals.writtenOff} />
              <LossStat
                label="Value"
                value={formatCents(totals.valueCents)}
              />
            </div>

            <div className="rounded-lg border">
              {/* The /equipment page's stock grid owns the window keyboard
                  shortcuts, so this grid must not listen. */}
              <DataGrid
                table={table}
                aria-label="Equipment losses by type"
                listenOnWindow={false}
              />
            </div>

            {report.data.events.length > 0 && (
              <div className="grid gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Recent events
                </h3>
                <div className="rounded-lg border">
                  <LossEventsGrid events={report.data.events.slice(0, 12)} />
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function LossStat({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xl font-bold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

type LossEvent = LossReport["events"][number];
const eventHelper = createColumnHelper<typeof gridFeatures, LossEvent>();
const eventColumns = eventHelper.columns([
  eventHelper.accessor((event) => event.date, {
    id: "date",
    header: "Date",
    meta: { card: "subtitle" } satisfies DataGridColumnMeta,
    cell: ({ getValue }) => formatDate(getValue()),
  }),
  eventHelper.accessor((event) => event.typeName, {
    id: "equipment",
    header: "Equipment",
    meta: { card: "title", cellClassName: "font-medium" } satisfies DataGridColumnMeta,
  }),
  eventHelper.accessor((event) => event.quantity, {
    id: "quantity",
    header: "Qty",
    meta: rightAligned,
  }),
  eventHelper.accessor((event) => LOSS_KIND_LABELS[event.kind] ?? event.kind, {
    id: "kind",
    header: "Kind",
    meta: { card: "badge", filter: true, filterAllLabel: "All kinds" } satisfies DataGridColumnMeta,
    cell: ({ getValue }) => <Badge variant="secondary">{getValue()}</Badge>,
  }),
  eventHelper.accessor((event) => reasonLabel(event.reason), {
    id: "reason",
    header: "Reason",
  }),
  eventHelper.accessor((event) => event.valueCents, {
    id: "value",
    header: "Value",
    meta: rightAligned,
    cell: ({ getValue }) => formatCents(getValue()),
  }),
  eventHelper.accessor((event) => event.notes ?? "", {
    id: "notes",
    header: "Notes",
    meta: { cellClassName: "whitespace-normal text-muted-foreground" } satisfies DataGridColumnMeta,
  }),
]);

function LossEventsGrid({ events }: { events: LossEvent[] }) {
  const table = useTable({
    features: gridFeatures,
    columns: eventColumns,
    data: events,
    getRowId: (event) => event.id,
  });
  return (
    <DataGrid
      table={table}
      aria-label="Recent equipment loss events"
      listenOnWindow={false}
      searchable={false}
    />
  );
}
