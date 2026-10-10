"use client";

/** A harvest session's hive entries: one row per hive weighed. */

import * as React from "react";
import { createColumnHelper, useTable } from "@tanstack/react-table";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
  dataGridFeatures,
} from "@/components/ui/data-grid";
import { useUnits } from "@/lib/use-units";

import type { HarvestSessionEntry } from "./types";

const helper = createColumnHelper<typeof dataGridFeatures, HarvestSessionEntry>();
const numeric: DataGridColumnMeta = { align: "right", cellClassName: "tabular-nums" };

export function SessionEntriesGrid({
  entries,
  onRemove,
}: {
  entries: HarvestSessionEntry[];
  onRemove: (entry: HarvestSessionEntry) => void;
}) {
  const { formatHoney } = useUnits();
  const columns = React.useMemo(
    () =>
      helper.columns([
        helper.accessor((e) => e.hiveName, {
          id: "hive",
          header: "Hive",
          meta: { cellClassName: "font-medium" } satisfies DataGridColumnMeta,
        }),
        helper.accessor((e) => (e.directWeight ? undefined : e.superWeightBefore), {
          id: "before",
          header: "Super before",
          sortUndefined: "last",
          meta: numeric,
          cell: ({ row: { original: e } }) =>
            e.directWeight ? (
              <span className="text-xs text-muted-foreground">Weighed directly</span>
            ) : (
              formatHoney(e.superWeightBefore)
            ),
        }),
        helper.accessor((e) => (e.directWeight ? undefined : e.superWeightAfter), {
          id: "after",
          header: "Super after",
          sortUndefined: "last",
          meta: numeric,
          cell: ({ row: { original: e } }) =>
            e.directWeight ? "—" : formatHoney(e.superWeightAfter),
        }),
        helper.accessor((e) => e.calculatedHoneyWeight, {
          id: "honey",
          header: "Honey",
          meta: { align: "right", cellClassName: "font-medium tabular-nums" } satisfies DataGridColumnMeta,
          cell: ({ getValue }) => formatHoney(getValue()),
        }),
        helper.accessor((e) => e.notes ?? "", {
          id: "notes",
          header: "Notes",
          meta: {
            cellClassName: "max-w-48 truncate text-muted-foreground",
          } satisfies DataGridColumnMeta,
          cell: ({ getValue }) => getValue() || "—",
        }),
        helper.display({
          id: "actions",
          header: "",
          meta: { align: "right" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) => (
            <DataGridCellAction>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-destructive"
                aria-label={`Remove entry for ${entry.hiveName}`}
                onClick={() => onRemove(entry)}
              >
                <Trash2 className="size-4" />
              </Button>
            </DataGridCellAction>
          ),
        }),
      ]),
    [formatHoney, onRemove],
  );
  const table = useTable({
    features: dataGridFeatures,
    columns,
    data: entries,
    getRowId: (entry) => entry.id,
  });
  return (
    <DataGrid
      table={table}
      aria-label="Hive entries"
      listenOnWindow={false}
      searchable={entries.length > 8}
    />
  );
}
