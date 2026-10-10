"use client";

/** The flora tab's bloom lists: what is flowering now, and every past bloom. */

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
import { formatDate } from "@/features/hives/lib";
import { useUnits } from "@/lib/use-units";

import type { BloomObservation } from "./hooks";

const helper = createColumnHelper<typeof dataGridFeatures, BloomObservation>();

const speciesColumn = helper.accessor((bloom) => bloom.species, {
  id: "species",
  header: "Species",
  meta: {
    card: "title",
    cellClassName: "font-medium",
    filter: true,
    filterAllLabel: "All species",
  } satisfies DataGridColumnMeta,
});
const bandColumn = helper.accessor((bloom) => bloom.elevationBandLabel, {
  id: "band",
  header: "Elevation band",
  meta: { filter: true, filterAllLabel: "All bands" } satisfies DataGridColumnMeta,
});

export function ActiveBloomsGrid({
  blooms,
  canEdit,
  ending,
  onEnd,
}: {
  blooms: BloomObservation[];
  canEdit: boolean;
  ending: boolean;
  onEnd: (id: string) => void;
}) {
  const units = useUnits();
  const columns = React.useMemo(
    () =>
      helper.columns([
        speciesColumn,
        helper.accessor((bloom) => bloom.dateFirstSeen, {
          id: "since",
          header: "Since",
          cell: ({ getValue }) => formatDate(getValue()),
        }),
        helper.accessor((bloom) => bloom.abundance ?? undefined, {
          id: "abundance",
          header: "Abundance",
          sortUndefined: "last",
          meta: { align: "right", cellClassName: "tabular-nums" } satisfies DataGridColumnMeta,
          cell: ({ getValue }) => {
            const value = getValue();
            return value == null ? "—" : `${value}/5`;
          },
        }),
        bandColumn,
        helper.accessor((bloom) => bloom.elevationM ?? undefined, {
          id: "elevation",
          header: "Elevation",
          sortUndefined: "last",
          meta: { align: "right", cellClassName: "tabular-nums" } satisfies DataGridColumnMeta,
          cell: ({ getValue }) => {
            const value = getValue();
            return value == null ? "—" : units.formatElevation(value);
          },
        }),
        ...(canEdit
          ? [
              helper.display({
                id: "actions",
                header: "",
                meta: { align: "right" } satisfies DataGridColumnMeta,
                cell: ({ row: { original: bloom } }) => (
                  <DataGridCellAction>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onEnd(bloom.id)}
                      disabled={ending}
                    >
                      End bloom
                    </Button>
                  </DataGridCellAction>
                ),
              }),
            ]
          : []),
      ]),
    [canEdit, ending, onEnd, units],
  );
  const table = useTable({
    features: dataGridFeatures,
    columns,
    data: blooms,
    getRowId: (bloom) => bloom.id,
  });
  return (
    <div className="rounded-md border">
      <DataGrid
        table={table}
        aria-label="Active blooms"
        listenOnWindow={false}
        searchable={blooms.length > 8}
      />
    </div>
  );
}

export function BloomHistoryGrid({
  blooms,
  canEdit,
  onDelete,
}: {
  blooms: BloomObservation[];
  canEdit: boolean;
  onDelete: (id: string) => void;
}) {
  const columns = React.useMemo(
    () =>
      helper.columns([
        speciesColumn,
        helper.accessor((bloom) => String(bloom.year), {
          id: "year",
          header: "Year",
          meta: { card: "badge", filter: true, filterAllLabel: "All years" } satisfies DataGridColumnMeta,
        }),
        bandColumn,
        helper.accessor((bloom) => bloom.dateFirstSeen, {
          id: "first",
          header: "First seen",
          cell: ({ getValue }) => formatDate(getValue()),
        }),
        helper.accessor((bloom) => bloom.dateLastSeen ?? undefined, {
          id: "last",
          header: "Last seen",
          sortUndefined: "last",
          cell: ({ getValue }) => {
            const value = getValue();
            return value ? formatDate(value) : "—";
          },
        }),
        ...(canEdit
          ? [
              helper.display({
                id: "actions",
                header: "",
                meta: { align: "right" } satisfies DataGridColumnMeta,
                cell: ({ row: { original: bloom } }) => (
                  <DataGridCellAction>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${bloom.species} observation`}
                      onClick={() => onDelete(bloom.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </DataGridCellAction>
                ),
              }),
            ]
          : []),
      ]),
    [canEdit, onDelete],
  );
  const table = useTable({
    features: dataGridFeatures,
    columns,
    data: blooms,
    getRowId: (bloom) => bloom.id,
  });
  return (
    <div className="rounded-md border">
      <DataGrid
        table={table}
        aria-label="Bloom history"
        listenOnWindow={false}
        searchable={blooms.length > 8}
      />
    </div>
  );
}
