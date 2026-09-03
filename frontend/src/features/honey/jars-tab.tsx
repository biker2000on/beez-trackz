"use client";

/**
 * Jars tab: derived jar inventory per size.
 *
 * On hand is split by where the jars actually are. "At home" is what can be
 * sold at market day; anything consigned to a shop is still the operator's
 * stock and still counts toward the total, but it is not on the table. Showing
 * one merged number was how the same jar got sold twice.
 */

import * as React from "react";
import Link from "next/link";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataGrid,
  type DataGridColumnMeta,
} from "@/components/ui/data-grid";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useStockInventory,
  type StockInventory,
} from "@/features/commerce/stock-locations-api";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useUnits } from "@/lib/use-units";

import { formatMoney } from "./format";
import { useJarInventory } from "./hooks";
import type { HoneyInventoryRow } from "./types";

/**
 * Per-jar-size counts keyed by location, plus the away locations that actually
 * hold something. Away columns only appear once stock is really out there, so
 * an operator with one location sees the table they have always seen.
 */
function splitByLocation(inventory: StockInventory | undefined) {
  const locations = inventory?.locations ?? [];
  const home = locations.find((location) => location.isHome);
  const away = locations.filter(
    (location) =>
      !location.isHome &&
      (inventory?.items ?? []).some((item) => (item.byLocation[location.id] ?? 0) !== 0),
  );
  const byJarSize = new Map<string, Record<string, number>>();
  for (const item of inventory?.items ?? []) {
    if (item.jarSizeId) byJarSize.set(item.jarSizeId, item.byLocation);
  }
  return { homeId: home?.id, away, byJarSize };
}

const gridFeatures = tableFeatures({});
const columnHelper = createColumnHelper<
  typeof gridFeatures,
  HoneyInventoryRow
>();

const rightAligned: DataGridColumnMeta = {
  align: "right",
  cellClassName: "tabular-nums",
};

/**
 * The DataGrid renders a plain table, so the old `pinFirstColumn` behavior
 * (globals.css keys off `data-pin-first-column`) is replicated inline: the
 * identifier column stays put while a wide table scrolls sideways. This table
 * sits on the page background, not a card, hence `bg-background`.
 */
const pinnedFirstColumn =
  "sticky left-0 z-[1] bg-background after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border";

/** An inactive jar size keeps its row but reads as retired. */
function Dim({
  faded,
  children,
}: {
  faded: boolean;
  children: React.ReactNode;
}) {
  return <div className={cn(faded && "opacity-60")}>{children}</div>;
}

export function JarsTab() {
  const { formatHoney } = useUnits();
  const inventory = useJarInventory();
  const locations = useStockInventory();

  const rows = React.useMemo(() => inventory.data ?? [], [inventory.data]);
  const { homeId, away, byJarSize } = React.useMemo(
    () => splitByLocation(locations.data),
    [locations.data],
  );

  const columns = React.useMemo(
    () =>
      columnHelper.columns([
        columnHelper.display({
          id: "size",
          header: "Size",
          meta: {
            headClassName: pinnedFirstColumn,
            cellClassName: cn("font-medium", pinnedFirstColumn),
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: row } }) => (
            <Dim faded={row.isActive === false}>
              {row.label}
              {row.honeyOz != null && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {formatHoney(row.honeyOz / 16)}
                </span>
              )}
              {row.isActive === false && (
                <Badge variant="outline" className="ml-2 text-muted-foreground">
                  inactive
                </Badge>
              )}
            </Dim>
          ),
        }),
        columnHelper.display({
          id: "atHome",
          header: "At home",
          meta: {
            align: "right",
            cellClassName: "font-semibold tabular-nums",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: row } }) => {
            const perLocation = byJarSize.get(row.jarSizeId) ?? {};
            // Fall back to the global figure while the locations request is
            // still in flight, rather than flashing a zero.
            const atHome = homeId ? (perLocation[homeId] ?? 0) : row.onHand;
            return (
              <Dim faded={row.isActive === false}>
                <span className={cn(atHome < 0 && "text-destructive")}>
                  {atHome}
                </span>
              </Dim>
            );
          },
        }),
        ...away.map((location) =>
          columnHelper.display({
            id: `away-${location.id}`,
            header: location.name,
            meta: {
              align: "right",
              cellClassName: "tabular-nums text-muted-foreground",
            } satisfies DataGridColumnMeta,
            cell: ({ row: { original: row } }) => (
              <Dim faded={row.isActive === false}>
                {(byJarSize.get(row.jarSizeId) ?? {})[location.id] ?? 0}
              </Dim>
            ),
          }),
        ),
        ...(away.length > 0
          ? [
              columnHelper.display({
                id: "total",
                header: "Total",
                meta: {
                  align: "right",
                  cellClassName: "font-semibold tabular-nums",
                } satisfies DataGridColumnMeta,
                cell: ({ row: { original: row } }) => (
                  <Dim faded={row.isActive === false}>
                    <span className={cn(row.onHand < 0 && "text-destructive")}>
                      {row.onHand}
                    </span>
                  </Dim>
                ),
              }),
            ]
          : []),
        columnHelper.display({
          id: "jarred",
          header: "Jarred",
          meta: rightAligned,
          cell: ({ row: { original: row } }) => (
            <Dim faded={row.isActive === false}>{row.jarred}</Dim>
          ),
        }),
        columnHelper.display({
          id: "sold",
          header: "Sold",
          meta: rightAligned,
          cell: ({ row: { original: row } }) => (
            <Dim faded={row.isActive === false}>{row.sold}</Dim>
          ),
        }),
        columnHelper.display({
          id: "given",
          header: "Given",
          meta: rightAligned,
          cell: ({ row: { original: row } }) => (
            <Dim faded={row.isActive === false}>{row.givenAway}</Dim>
          ),
        }),
        columnHelper.display({
          id: "adjusted",
          header: "Adjusted",
          meta: rightAligned,
          cell: ({ row: { original: row } }) => (
            <Dim faded={row.isActive === false}>
              {row.adjusted > 0 ? `+${row.adjusted}` : row.adjusted}
            </Dim>
          ),
        }),
        columnHelper.display({
          id: "price",
          header: "Price",
          meta: rightAligned,
          cell: ({ row: { original: row } }) => (
            <Dim faded={row.isActive === false}>
              {row.defaultPrice != null ? formatMoney(row.defaultPrice) : "—"}
            </Dim>
          ),
        }),
      ]),
    [away, byJarSize, homeId, formatHoney],
  );

  const table = useTable({
    features: gridFeatures,
    columns,
    data: rows,
    getRowId: (row) => row.jarSizeId,
  });

  if (inventory.isPending) {
    return <Skeleton className="h-48 w-full" />;
  }
  if (inventory.isError) {
    return (
      <TabLoadError
        message={
          inventory.error instanceof ApiError && inventory.error.status === 403
            ? "Administrator access required"
            : "Could not load jar inventory."
        }
        onRetry={() => void inventory.refetch()}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No jar sizes configured. Add sizes in Settings first.
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="rounded-lg border">
        <DataGrid table={table} aria-label="Jar inventory" />
      </div>
      {away.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Jars at another location are still yours, but market day can only sell
          what is at home.{" "}
          <Link className="underline underline-offset-2" href="/sales/consignment">
            Manage consignment
          </Link>
          .
        </p>
      )}
    </div>
  );
}

function TabLoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="grid justify-items-center gap-3 py-8 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href="/production">Back to Honey</Link>
        </Button>
        <Button type="button" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}
