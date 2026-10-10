"use client";

/** A harvest lot's bottling runs; a row opens the full run record. */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createColumnHelper, useTable } from "@tanstack/react-table";

import {
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
  dataGridFeatures,
} from "@/components/ui/data-grid";
import { formatDate, formatLbs } from "@/features/honey/format";

import type { HarvestLot } from "./api";

type BottlingRun = HarvestLot["bottlingRuns"][number];

const helper = createColumnHelper<typeof dataGridFeatures, BottlingRun>();
const numeric: DataGridColumnMeta = { align: "right", cellClassName: "tabular-nums" };

function columnsFor(lotId: string) {
  return helper.columns([
    helper.accessor((run) => run.bottledDate, {
      id: "bottled",
      header: "Bottled",
      meta: { card: "subtitle" } satisfies DataGridColumnMeta,
      cell: ({ getValue }) => formatDate(getValue()),
    }),
    helper.accessor((run) => run.jarSizeLabel ?? "jars", {
      id: "size",
      header: "Jar size",
      meta: {
        card: "title",
        cellClassName: "font-medium",
        filter: true,
        filterAllLabel: "All sizes",
      } satisfies DataGridColumnMeta,
    }),
    helper.accessor((run) => run.quantity, {
      id: "quantity",
      header: "Jars",
      meta: numeric,
    }),
    helper.accessor((run) => run.honeyLbs ?? undefined, {
      id: "honey",
      header: "Honey drawn",
      sortUndefined: "last",
      meta: numeric,
      cell: ({ row: { original: run } }) =>
        run.honeyLbs == null ? (
          <span className="text-muted-foreground">Not recorded</span>
        ) : (
          formatLbs(run.honeyLbs)
        ),
    }),
    helper.accessor((run) => run.serialCount, {
      id: "serials",
      header: "Serials",
      meta: numeric,
    }),
    helper.display({
      id: "actions",
      header: "",
      meta: { align: "right" } satisfies DataGridColumnMeta,
      cell: ({ row: { original: run } }) => (
        <DataGridCellAction>
          <Link
            href={`/production/lots/${lotId}/runs/${run.id}`}
            className="text-sm underline"
          >
            Full run record
          </Link>
        </DataGridCellAction>
      ),
    }),
  ]);
}

export function BottlingRunsGrid({
  lotId,
  runs,
}: {
  lotId: string;
  runs: BottlingRun[];
}) {
  const router = useRouter();
  const table = useTable({
    features: dataGridFeatures,
    columns: React.useMemo(() => columnsFor(lotId), [lotId]),
    data: runs,
    getRowId: (run) => run.id,
  });
  return (
    <DataGrid
      table={table}
      aria-label="Bottling history"
      searchable={runs.length > 8}
      onRowActivate={(run) => router.push(`/production/lots/${lotId}/runs/${run.id}`)}
      emptyMessage="No bottling runs recorded."
    />
  );
}
