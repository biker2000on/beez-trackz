"use client";

/**
 * The Varroa panel's lists: counts that cannot become a rate (no days on
 * board), and each treatment's before/after effect.
 */

import * as React from "react";
import { createColumnHelper, useTable } from "@tanstack/react-table";
import { Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
  dataGridFeatures,
} from "@/components/ui/data-grid";
import { formatDate } from "@/features/hives/lib";

import type { MiteCount, TreatmentEffect } from "./hooks";

const methodLabels: Record<string, string> = {
  alcohol_wash: "Alcohol wash",
  sugar_roll: "Sugar roll",
  sticky_board: "Sticky board",
  visual: "Visual count",
};

const countHelper = createColumnHelper<typeof dataGridFeatures, MiteCount>();
const treatmentHelper = createColumnHelper<
  typeof dataGridFeatures,
  TreatmentEffect
>();
const numeric: DataGridColumnMeta = { align: "right", cellClassName: "tabular-nums" };

export function RawMiteCountsGrid({
  counts,
  canEdit,
  onEdit,
  onDelete,
}: {
  counts: MiteCount[];
  canEdit: boolean;
  onEdit: (count: MiteCount) => void;
  onDelete: (count: MiteCount) => void;
}) {
  const columns = React.useMemo(
    () =>
      countHelper.columns([
        countHelper.accessor((c) => c.date, {
          id: "date",
          header: "Date",
          meta: { card: "subtitle" } satisfies DataGridColumnMeta,
          cell: ({ getValue }) => formatDate(getValue()),
        }),
        countHelper.accessor((c) => c.mitesCount, {
          id: "mites",
          header: "Mites",
          meta: { ...numeric, card: "title", cellClassName: "tabular-nums font-medium" },
        }),
        countHelper.accessor((c) => methodLabels[c.method] ?? c.method, {
          id: "method",
          header: "Method",
          meta: { filter: true, filterAllLabel: "All methods" } satisfies DataGridColumnMeta,
        }),
        countHelper.accessor((c) => c.notes ?? "", {
          id: "notes",
          header: "Notes",
          meta: { cellClassName: "whitespace-normal text-muted-foreground" } satisfies DataGridColumnMeta,
        }),
        ...(canEdit
          ? [
              countHelper.display({
                id: "actions",
                header: "",
                meta: { align: "right" } satisfies DataGridColumnMeta,
                cell: ({ row: { original: c } }) => (
                  <DataGridCellAction className="inline-flex">
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="Edit count" onClick={() => onEdit(c)}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="Delete count" onClick={() => onDelete(c)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </DataGridCellAction>
                ),
              }),
            ]
          : []),
      ]),
    [canEdit, onEdit, onDelete],
  );
  const table = useTable({
    features: dataGridFeatures,
    columns,
    data: counts,
    getRowId: (c) => c.id,
  });
  return (
    <div className="rounded-md border">
      <DataGrid
        table={table}
        aria-label="Board drop and visual counts"
        listenOnWindow={false}
        searchable={false}
      />
    </div>
  );
}

function rateUnit(t: TreatmentEffect) {
  return t.beforeRateKind === "per_day" || t.afterRateKind === "per_day"
    ? "/ day"
    : "/ 100";
}

const treatmentColumns = treatmentHelper.columns([
  treatmentHelper.accessor((t) => t.product, {
    id: "product",
    header: "Treatment",
    meta: { card: "title", cellClassName: "font-medium" } satisfies DataGridColumnMeta,
  }),
  treatmentHelper.accessor((t) => t.dateApplied, {
    id: "applied",
    header: "Applied",
    meta: { card: "subtitle" } satisfies DataGridColumnMeta,
    cell: ({ getValue }) => formatDate(getValue()),
  }),
  treatmentHelper.accessor((t) => t.method ?? "", {
    id: "method",
    header: "Method",
    cell: ({ getValue }) => getValue() || "—",
  }),
  treatmentHelper.accessor((t) => t.beforeRate ?? t.beforeMitesPer100 ?? undefined, {
    id: "before",
    header: "Before",
    sortUndefined: "last",
    meta: numeric,
    cell: ({ row: { original: t }, getValue }) => {
      const value = getValue();
      return value == null ? "—" : `${value.toFixed(1)} ${rateUnit(t)}`;
    },
  }),
  treatmentHelper.accessor((t) => t.afterRate ?? t.afterMitesPer100 ?? undefined, {
    id: "after",
    header: "After",
    sortUndefined: "last",
    meta: numeric,
    cell: ({ row: { original: t }, getValue }) => {
      const value = getValue();
      return value == null ? "—" : `${value.toFixed(1)} ${rateUnit(t)}`;
    },
  }),
  treatmentHelper.accessor((t) => t.efficacyPercent ?? undefined, {
    id: "efficacy",
    header: "Reduction",
    sortUndefined: "last",
    meta: { ...numeric, cellClassName: "tabular-nums font-semibold" },
    cell: ({ row: { original: t } }) =>
      t.efficacyPercent == null ? (
        <span className="text-xs font-normal text-muted-foreground">
          {t.beforeRate != null && t.afterRate == null
            ? "No matching after count"
            : "Needs before/after counts"}
        </span>
      ) : (
        `${t.efficacyPercent.toFixed(0)}%`
      ),
  }),
]);

export function TreatmentEffectGrid({
  treatments,
}: {
  treatments: TreatmentEffect[];
}) {
  const table = useTable({
    features: dataGridFeatures,
    columns: treatmentColumns,
    data: treatments,
    getRowId: (t) => t.id,
  });
  return (
    <div className="rounded-md border">
      <DataGrid
        table={table}
        aria-label="Treatment efficacy"
        listenOnWindow={false}
        searchable={false}
      />
    </div>
  );
}
