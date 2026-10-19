"use client";

/**
 * Manage mode for queens: every queen as a selectable grid row (click,
 * Space or Enter toggles), sortable and filterable, feeding the bulk bar.
 */

import * as React from "react";
import { createColumnHelper, useTable } from "@tanstack/react-table";

import { Checkbox } from "@/components/ui/checkbox";
import {
  DataGrid,
  gridMeta,
  type DataGridColumnMeta,
  dataGridFeatures,
} from "@/components/ui/data-grid";

import { QUEEN_STATUS_LABELS, type Queen } from "./api";
import { markingColorForDate } from "./marking";

const helper = createColumnHelper<typeof dataGridFeatures, Queen>();

/** What the select cells read from `table.options.meta`. */
interface QueenGridMeta {
  selected: Set<string>;
}

export function QueenManageGrid({
  queens,
  selected,
  onToggle,
}: {
  queens: Queen[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const columns = React.useMemo(
    () =>
      helper.columns([
        helper.display({
          id: "select",
          header: () => <span className="sr-only">Selected</span>,
          meta: { headClassName: "w-10", card: "badge" } satisfies DataGridColumnMeta,
          cell: ({ row, table }) => (
            <Checkbox
              checked={gridMeta<QueenGridMeta>(table).selected.has(row.original.id)}
              aria-hidden
              tabIndex={-1}
              className="pointer-events-none"
            />
          ),
        }),
        helper.accessor(
          (q) =>
            q.apiaryName && q.hiveName
              ? `${q.apiaryName} — ${q.hiveName}`
              : "Unassigned queen",
          {
            id: "queen",
            header: "Queen",
            meta: { card: "title", cellClassName: "font-medium" } satisfies DataGridColumnMeta,
            cell: ({ row: { original: q }, getValue }) => {
              const marking = markingColorForDate(q.introducedDate);
              return (
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-3 shrink-0 rounded-full border"
                    style={{ backgroundColor: marking?.color ?? "transparent" }}
                  />
                  {getValue()}
                </span>
              );
            },
          },
        ),
        helper.accessor((q) => q.apiaryName ?? "", {
          id: "apiary",
          header: "Apiary",
          meta: { card: "hidden", filter: true, filterAllLabel: "All apiaries" } satisfies DataGridColumnMeta,
          cell: ({ getValue }) => getValue() || "—",
        }),
        helper.accessor((q) => q.origin.replaceAll("_", " "), {
          id: "origin",
          header: "Origin",
          meta: { cellClassName: "capitalize", filter: true, filterAllLabel: "Any origin" } satisfies DataGridColumnMeta,
        }),
        helper.accessor((q) => markingColorForDate(q.introducedDate)?.year ?? undefined, {
          id: "year",
          header: "Marking year",
          sortUndefined: "last",
          meta: { align: "right", cellClassName: "tabular-nums" } satisfies DataGridColumnMeta,
          cell: ({ getValue }) => getValue() ?? "—",
        }),
        helper.accessor((q) => QUEEN_STATUS_LABELS[q.status], {
          id: "status",
          header: "Status",
          meta: { filter: true, filterAllLabel: "Any status" } satisfies DataGridColumnMeta,
        }),
      ]),
    [],
  );
  // The selection reaches the cells through `meta` so toggling a row never
  // rebuilds a column (see data-grid.tsx).
  const gridState: QueenGridMeta = { selected };
  const table = useTable({
    features: dataGridFeatures,
    columns,
    meta: gridState,
    data: queens,
    getRowId: (q) => q.id,
  });
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <DataGrid
        table={table}
        aria-label="Queens"
        onRowActivate={(q) => onToggle(q.id)}
        rowProps={(q) => ({
          tabIndex: 0,
          "aria-selected": selected.has(q.id),
          className: selected.has(q.id) ? "bg-muted" : undefined,
          onKeyDown: (event) => {
            if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              onToggle(q.id);
            }
          },
        })}
      />
    </div>
  );
}
