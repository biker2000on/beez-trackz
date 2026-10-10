"use client";

/**
 * Harvest lots as a sortable, filterable grid. The QR label, ancestry and
 * full bottling history live on each lot's record page; a row opens it.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createColumnHelper, useTable } from "@tanstack/react-table";
import { ExternalLink, PackagePlus, Pencil } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
  dataGridFeatures,
} from "@/components/ui/data-grid";
import { formatDate, formatLbs } from "@/features/honey/format";

import type { HarvestLot } from "./api";

const helper = createColumnHelper<typeof dataGridFeatures, HarvestLot>();
const numeric: DataGridColumnMeta = { align: "right", cellClassName: "tabular-nums" };

function weightNote(lot: HarvestLot): string | null {
  if (lot.honeyWeightSource === "derived") {
    return `Derived from ${lot.linkedHarvestCount} ${
      lot.linkedHarvestCount === 1 ? "harvest" : "harvests"
    }`;
  }
  if (lot.linkedHarvestCount > 0 && lot.derivedWeightLbs !== lot.honeyWeightLbs) {
    return `Typed; ${lot.linkedHarvestCount} ${
      lot.linkedHarvestCount === 1 ? "harvest sums" : "harvests sum"
    } to ${formatLbs(lot.derivedWeightLbs)}`;
  }
  return null;
}

function moistureText(lot: HarvestLot): string | null {
  if (lot.moisturePct == null && lot.bottlingMoisturePct == null) return null;
  return [
    lot.moisturePct != null ? `Extracted ${lot.moisturePct}%` : null,
    lot.bottlingMoisturePct != null ? `Bottled ${lot.bottlingMoisturePct}%` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function LotsGrid({
  lots,
  onBottle,
  onEdit,
}: {
  lots: HarvestLot[];
  onBottle: (lot: HarvestLot) => void;
  onEdit: (lot: HarvestLot) => void;
}) {
  const router = useRouter();
  const columns = React.useMemo(
    () =>
      helper.columns([
        helper.accessor((lot) => lot.lotCode, {
          id: "lot",
          header: "Lot",
          meta: { card: "title", cellClassName: "font-medium" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: lot } }) => (
            <DataGridCellAction className="inline">
              <Link href={`/production/lots/${lot.id}`} className="hover:underline">
                {lot.lotCode}
              </Link>
            </DataGridCellAction>
          ),
        }),
        helper.accessor((lot) => lot.extractionDate, {
          id: "extracted",
          header: "Extracted",
          meta: { card: "subtitle" } satisfies DataGridColumnMeta,
          cell: ({ getValue }) => formatDate(getValue()),
        }),
        helper.accessor(
          (lot) => lot.floralClaim || lot.varietalName || "No varietal assigned",
          {
            id: "varietal",
            header: "Varietal",
            meta: { filter: true, filterAllLabel: "All varietals" } satisfies DataGridColumnMeta,
          },
        ),
        helper.accessor((lot) => lot.season ?? "", {
          id: "season",
          header: "Season",
          meta: { filter: true, filterAllLabel: "All seasons" } satisfies DataGridColumnMeta,
          cell: ({ getValue }) => getValue() || "—",
        }),
        helper.accessor((lot) => lot.honeyWeightLbs, {
          id: "honey",
          header: "Honey",
          meta: numeric,
          cell: ({ row: { original: lot } }) => {
            const note = weightNote(lot);
            return (
              <span title={note ?? undefined}>
                {formatLbs(lot.honeyWeightLbs)}
                {lot.honeyWeightSource === "derived" ? (
                  <span className="ml-1 text-xs text-muted-foreground">derived</span>
                ) : null}
              </span>
            );
          },
        }),
        helper.accessor(
          (lot) => lot.bottlingRuns.reduce((total, run) => total + run.quantity, 0),
          {
            id: "jars",
            header: "Jars bottled",
            meta: numeric,
            cell: ({ row: { original: lot }, getValue }) =>
              lot.bottlingRuns.length === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <span
                  title={`${lot.bottlingRuns.length} ${
                    lot.bottlingRuns.length === 1 ? "run" : "runs"
                  }`}
                >
                  {getValue()}
                </span>
              ),
          },
        ),
        helper.accessor(
          (lot) =>
            lot.apiaryRegion ?? (lot.sourceApiaries.join(", ") || ""),
          {
            id: "region",
            header: "Region",
            meta: { cellClassName: "max-w-48 truncate text-muted-foreground" } satisfies DataGridColumnMeta,
            cell: ({ getValue }) => getValue() || "Not published",
          },
        ),
        helper.accessor((lot) => moistureText(lot) ?? "", {
          id: "moisture",
          header: "Moisture",
          meta: { cellClassName: "text-xs text-muted-foreground" } satisfies DataGridColumnMeta,
          cell: ({ getValue }) => getValue() || "—",
        }),
        helper.accessor(
          (lot) =>
            lot.lockout?.locked ? "Locked" : lot.isPublic ? "Public story" : "Private",
          {
            id: "status",
            header: "Status",
            meta: { card: "badge", filter: true, filterAllLabel: "Any status" } satisfies DataGridColumnMeta,
            cell: ({ row: { original: lot } }) => (
              <span className="inline-flex flex-wrap gap-1">
                <Badge variant={lot.isPublic ? "accent" : "outline"}>
                  {lot.isPublic ? "Public story" : "Private"}
                </Badge>
                {lot.lockout?.locked && (
                  <Badge variant="destructive" title={lot.lockout.message}>
                    Locked
                  </Badge>
                )}
              </span>
            ),
          },
        ),
        helper.display({
          id: "actions",
          header: "",
          meta: { align: "right", card: "field" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: lot } }) => (
            <DataGridCellAction className="flex flex-wrap justify-end gap-1">
              <Button variant="outline" size="sm" onClick={() => onBottle(lot)}>
                <PackagePlus /> Add bottling run
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onEdit(lot)}>
                <Pencil /> Edit lot
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link href={`/honey/${lot.publicSlug}`} target="_blank">
                  Honey Story <ExternalLink className="size-3" />
                </Link>
              </Button>
            </DataGridCellAction>
          ),
        }),
      ]),
    [onBottle, onEdit],
  );
  const table = useTable({
    features: dataGridFeatures,
    columns,
    data: lots,
    getRowId: (lot) => lot.id,
  });
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <DataGrid
        table={table}
        aria-label="Harvest lots"
        searchPlaceholder="Lot, varietal, season, region… (press / to focus)"
        onRowActivate={(lot) => router.push(`/production/lots/${lot.id}`)}
      />
    </div>
  );
}
