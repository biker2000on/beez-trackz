"use client";

/** Equipment out on hives, one row per item × hive balance. */

import * as React from "react";
import { createColumnHelper, useTable } from "@tanstack/react-table";
import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
  dataGridFeatures,
} from "@/components/ui/data-grid";

import { formatDate } from "./format";
import { CATEGORY_LABELS, type ActiveDeployment } from "./types";

const helper = createColumnHelper<typeof dataGridFeatures, ActiveDeployment>();
const numeric: DataGridColumnMeta = { align: "right", cellClassName: "tabular-nums" };

export function DeploymentsGrid({
  deployments,
  onReturn,
}: {
  deployments: ActiveDeployment[];
  onReturn: (deployment: ActiveDeployment) => void;
}) {
  const columns = React.useMemo(
    () =>
      helper.columns([
        helper.accessor((d) => d.typeName, {
          id: "equipment",
          header: "Equipment",
          meta: { cellClassName: "font-medium" } satisfies DataGridColumnMeta,
        }),
        helper.accessor((d) => CATEGORY_LABELS[d.typeCategory] ?? d.typeCategory, {
          id: "category",
          header: "Category",
          meta: { filter: true, filterAllLabel: "All categories" } satisfies DataGridColumnMeta,
        }),
        helper.accessor((d) => d.hiveLabel, {
          id: "hive",
          header: "Hive",
          meta: { card: "subtitle", filter: true, filterAllLabel: "All hives" } satisfies DataGridColumnMeta,
        }),
        helper.accessor((d) => d.dateDeployed, {
          id: "deployed",
          header: "Deployed",
          cell: ({ getValue }) => formatDate(getValue()),
        }),
        helper.accessor((d) => d.quantity, {
          id: "sent",
          header: "Sent",
          meta: numeric,
        }),
        helper.accessor((d) => d.quantityReturned, {
          id: "returned",
          header: "Back",
          meta: numeric,
        }),
        helper.accessor((d) => d.outstanding, {
          id: "outstanding",
          header: "On hive",
          meta: { ...numeric, cellClassName: "tabular-nums font-semibold" },
        }),
        helper.display({
          id: "actions",
          header: "",
          meta: { align: "right" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: d } }) => (
            <DataGridCellAction>
              <Button variant="outline" size="sm" onClick={() => onReturn(d)}>
                <RotateCcw />
                Return
              </Button>
            </DataGridCellAction>
          ),
        }),
      ]),
    [onReturn],
  );
  const table = useTable({
    features: dataGridFeatures,
    columns,
    data: deployments,
    getRowId: (d) => d.id,
  });
  return (
    <DataGrid
      table={table}
      aria-label="Active deployments"
      listenOnWindow={false}
      searchable={deployments.length > 8}
    />
  );
}
