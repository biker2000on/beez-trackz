"use client";

/** Tabular lists on a hive's record: feedings and splits. */

import * as React from "react";
import Link from "next/link";
import { createColumnHelper, useTable } from "@tanstack/react-table";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
  dataGridFeatures,
} from "@/components/ui/data-grid";
import {
  feederTypeLabel,
  feedingTypeLabel,
  formatFeedingAmount,
  type Feeding,
} from "@/features/feedings/hooks";
import { useUnits } from "@/lib/use-units";

import type { HiveSplit } from "./hooks";
import { formatDate } from "./lib";

const feedingHelper = createColumnHelper<typeof dataGridFeatures, Feeding>();
const splitHelper = createColumnHelper<typeof dataGridFeatures, HiveSplit>();

function feedingStatusLabel(feeding: Feeding): string {
  if (feeding.status === "closed") return "Closed";
  if (feeding.status === "unverified") return "Verify in field";
  return "On hive";
}

export interface FeedingActions {
  onRefill: (id: string) => void;
  onClose: (id: string, reason: string, success: string) => void;
  onDelete: (id: string) => void;
  refilling: boolean;
  closing: boolean;
  deleting: boolean;
}

export function FeedingsGrid({
  feedings,
  canEdit,
  actions,
}: {
  feedings: Feeding[];
  canEdit: boolean;
  actions: FeedingActions;
}) {
  const units = useUnits();
  const columns = React.useMemo(
    () =>
      feedingHelper.columns([
        feedingHelper.accessor((f) => feedingTypeLabel(f.type), {
          id: "type",
          header: "Feed",
          meta: {
            card: "title",
            cellClassName: "font-medium",
            filter: true,
            filterAllLabel: "All feed",
          } satisfies DataGridColumnMeta,
        }),
        feedingHelper.accessor((f) => f.quantity, {
          id: "amount",
          header: "Amount",
          meta: { align: "right", cellClassName: "tabular-nums" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: f } }) =>
            formatFeedingAmount(f.quantity, f.quantityUnit, units.units),
        }),
        feedingHelper.accessor((f) => f.dateFed, {
          id: "fed",
          header: "Fed",
          cell: ({ getValue }) => formatDate(getValue()),
        }),
        feedingHelper.accessor((f) => (f.feederType ? feederTypeLabel(f.feederType) : ""), {
          id: "feeder",
          header: "Feeder",
          cell: ({ getValue }) => getValue() || "—",
        }),
        feedingHelper.accessor(feedingStatusLabel, {
          id: "status",
          header: "Status",
          meta: { card: "badge", filter: true, filterAllLabel: "Any status" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: f } }) =>
            f.status === "closed" ? (
              <span className="text-muted-foreground">
                Closed {formatDate(f.dateEmpty ?? f.closedAt ?? f.dateFed)}
              </span>
            ) : f.status === "unverified" ? (
              <Badge variant="outline" title="No recorded end — verify in the field">
                Verify in field
              </Badge>
            ) : (
              <Badge variant="secondary">On hive</Badge>
            ),
        }),
        ...(canEdit
          ? [
              feedingHelper.display({
                id: "actions",
                header: "",
                meta: { align: "right", card: "field" } satisfies DataGridColumnMeta,
                cell: ({ row: { original: f } }) => (
                  <DataGridCellAction className="flex flex-wrap justify-end gap-2">
                    {f.status === "open" && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => actions.onRefill(f.id)}
                          disabled={actions.refilling}
                        >
                          Refill
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => actions.onClose(f.id, "emptied", "Feeder closed")}
                          disabled={actions.closing}
                        >
                          Close
                        </Button>
                      </>
                    )}
                    {f.status === "unverified" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          actions.onClose(
                            f.id,
                            "verified_closed",
                            "Verified — no feeder on the hive",
                          )
                        }
                        disabled={actions.closing}
                      >
                        Verify &amp; close
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => actions.onDelete(f.id)}
                      disabled={actions.deleting}
                    >
                      Delete
                    </Button>
                  </DataGridCellAction>
                ),
              }),
            ]
          : []),
      ]),
    [actions, canEdit, units.units],
  );
  const table = useTable({
    features: dataGridFeatures,
    columns,
    data: feedings,
    getRowId: (f) => f.id,
  });
  return (
    <div className="rounded-md border">
      <DataGrid
        table={table}
        aria-label="Feedings"
        listenOnWindow={false}
        searchable={feedings.length > 8}
      />
    </div>
  );
}

export function SplitsGrid({
  hiveId,
  splits,
}: {
  hiveId: string;
  splits: HiveSplit[];
}) {
  const columns = React.useMemo(() => {
    const isParent = (s: HiveSplit) => s.parentHiveId === hiveId;
    return splitHelper.columns([
      splitHelper.accessor((s) => (isParent(s) ? s.childLabel : s.parentLabel), {
        id: "hive",
        header: "Other hive",
        meta: { card: "title", cellClassName: "font-medium" } satisfies DataGridColumnMeta,
        cell: ({ row: { original: s } }) => (
          <DataGridCellAction className="inline">
            {isParent(s) ? "Split into " : "Split from "}
            <Link
              href={`/yard/hives/${isParent(s) ? s.childHiveId : s.parentHiveId}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              {isParent(s) ? s.childLabel : s.parentLabel}
            </Link>
          </DataGridCellAction>
        ),
      }),
      splitHelper.accessor((s) => (isParent(s) ? "Parent" : "Child"), {
        id: "role",
        header: "This hive",
        meta: { card: "badge", filter: true, filterAllLabel: "Parent and child" } satisfies DataGridColumnMeta,
        cell: ({ getValue }) => (
          <Badge variant={getValue() === "Parent" ? "secondary" : "outline"}>
            {getValue()}
          </Badge>
        ),
      }),
      splitHelper.accessor((s) => s.splitDate, {
        id: "date",
        header: "Date",
        cell: ({ getValue }) => formatDate(getValue()),
      }),
      splitHelper.accessor((s) => s.splitType, {
        id: "type",
        header: "Type",
        meta: { cellClassName: "capitalize" } satisfies DataGridColumnMeta,
      }),
      splitHelper.accessor((s) => s.framesMoved ?? undefined, {
        id: "frames",
        header: "Frames moved",
        sortUndefined: "last",
        meta: { align: "right", cellClassName: "tabular-nums" } satisfies DataGridColumnMeta,
        cell: ({ getValue }) => getValue() ?? "—",
      }),
      splitHelper.accessor((s) => s.notes ?? "", {
        id: "notes",
        header: "Notes",
        meta: { cellClassName: "whitespace-normal text-muted-foreground" } satisfies DataGridColumnMeta,
      }),
    ]);
  }, [hiveId]);
  const table = useTable({
    features: dataGridFeatures,
    columns,
    data: splits,
    getRowId: (s) => s.id,
  });
  return (
    <div className="rounded-md border">
      <DataGrid
        table={table}
        aria-label="Splits"
        listenOnWindow={false}
        searchable={false}
      />
    </div>
  );
}
