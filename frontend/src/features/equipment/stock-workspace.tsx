"use client";
import Link from "next/link";
import * as React from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper, useTable } from "@tanstack/react-table";
import { api } from "@/lib/api";
import { useAccessProfile } from "@/features/access/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
  dataGridFeatures,
} from "@/components/ui/data-grid";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePageTitle } from "@/components/shell/page-header";
import { useStoredFlag } from "@/lib/use-stored-flag";
import { formatStockQuantity, parseStockQuantity } from "./stock-format";

export interface StockRow {
  itemId: string;
  itemName: string;
  kind: string;
  unit: string;
  locationId: string | null;
  locationName: string | null;
  lotId: string | null;
  lotCode: string | null;
  harvestLotId: string | null;
  condition: string | null;
  hiveId: string | null;
  onHand: string;
  reserved: string;
  available: string;
  countKnown: boolean;
  originKnown: boolean;
  holds: { kind: string; reason: string; until: string | null }[];
  holdsKnown?: boolean;
}
type HistoryEntry = {
  operationId: string;
  kind: string;
  reason: string;
  occurredAt: string;
  quantity: string;
  sourceType: string;
  sourceId: string;
  lotId: string | null;
  harvestLotId?: string | null;
  hiveId: string | null;
};
interface StockRead {
  asOf: string;
  freshness: { stale: boolean; origin: string };
  rows: StockRow[];
  history?: HistoryEntry[];
}
const kinds: Record<string, string> = {
  equipment: "equipment",
  bulk: "bulk_honey",
  packaging: "packaging",
  finished: "jar",
};
function sourceHref(entry: HistoryEntry) {
  const id = encodeURIComponent(entry.sourceId);
  if (entry.sourceType === "sale") return `/sales/${id}`;
  if (entry.sourceType === "hive") return `/yard/hives/${id}`;
  if (entry.sourceType === "harvest_lot") return `/production/lots/${id}`;
  if (entry.sourceType === "harvest_session")
    return `/production/sessions/${id}`;
  if (entry.sourceType === "product_batch")
    return `/production/products/batches/${id}`;
  if (entry.sourceType === "bottling_run" && entry.harvestLotId)
    return `/production/lots/${encodeURIComponent(entry.harvestLotId!)}/runs/${id}`;
  return null;
}
function clock(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
const CONDITION_LABELS: Record<string, string> = {
  serviceable: "Ready",
  damaged: "Damaged",
  retired: "Retired",
};
function conditionLabel(condition: string | null) {
  return condition ? (CONDITION_LABELS[condition] ?? condition) : "Unassigned";
}

/** Zero on hand, nothing reserved: a ledger row with nothing in it. */
export function isEmptyStockRow(row: StockRow): boolean {
  if (!row.countKnown) return false;
  return (
    parseStockQuantity(row.onHand) === 0 &&
    (parseStockQuantity(row.reserved) ?? 0) === 0
  );
}

const EMPTY_ROWS: StockRow[] = [];
const EMPTY_HISTORY: HistoryEntry[] = [];
const columnHelper = createColumnHelper<typeof dataGridFeatures, StockRow>();
const historyHelper = createColumnHelper<
  typeof dataGridFeatures,
  HistoryEntry
>();
const quantityMeta: DataGridColumnMeta = {
  align: "right",
  cellClassName: "tabular-nums",
};

function UnknownQuantity() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label="Unknown"
          className="cursor-help text-muted-foreground underline decoration-dotted underline-offset-4"
        >
          —
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Not counted yet. Record a physical count to establish this stock.
      </TooltipContent>
    </Tooltip>
  );
}

function itemHref(row: StockRow) {
  return `/stock/items/${row.itemId}?${new URLSearchParams({
    locationId: row.locationId ?? "null",
    lotId: row.lotId ?? "null",
    condition: row.condition ?? "null",
    hiveId: row.hiveId ?? "null",
  })}`;
}

/** Ledger quantity for sorting; unknown counts sort last. */
function quantityValue(row: StockRow, key: "onHand" | "reserved" | "available") {
  if (key !== "reserved" && !row.countKnown) return undefined;
  return parseStockQuantity(row[key]) ?? undefined;
}

const stockColumns = columnHelper.columns([
  columnHelper.accessor((row) => row.itemName, {
    id: "item",
    header: "Item",
    meta: { card: "title" } satisfies DataGridColumnMeta,
    cell: ({ row: { original: row } }) => (
      <DataGridCellAction className="inline-flex flex-wrap items-center gap-2">
        <Link
          className="font-semibold underline-offset-4 hover:underline"
          href={itemHref(row)}
        >
          {row.itemName}
        </Link>
        {row.hiveId && <Badge variant="secondary">In field</Badge>}
      </DataGridCellAction>
    ),
  }),
  columnHelper.accessor((row) => row.locationName ?? "Unassigned", {
    id: "location",
    header: "Location",
    meta: { filter: true, filterAllLabel: "All locations" } satisfies DataGridColumnMeta,
  }),
  columnHelper.accessor((row) => row.lotCode ?? "", {
    id: "lot",
    header: "Lot",
    sortUndefined: "last",
    meta: { filter: true, filterAllLabel: "All lots" } satisfies DataGridColumnMeta,
    cell: ({ row: { original: row } }) =>
      row.harvestLotId ? (
        <DataGridCellAction className="inline">
          <Link
            className="underline underline-offset-4"
            href={`/production/lots/${row.harvestLotId}`}
          >
            {row.lotCode ?? "Lot record"}
          </Link>
        </DataGridCellAction>
      ) : (
        (row.lotCode ?? <span className="text-muted-foreground">—</span>)
      ),
  }),
  columnHelper.accessor((row) => conditionLabel(row.condition), {
    id: "condition",
    header: "Condition",
    meta: {
      filter: true,
      filterAllLabel: "Any condition",
    } satisfies DataGridColumnMeta,
  }),
  columnHelper.accessor((row) => quantityValue(row, "onHand"), {
    id: "onHand",
    header: "On hand",
    sortUndefined: "last",
    meta: quantityMeta,
    cell: ({ row: { original: row } }) =>
      row.countKnown ? formatStockQuantity(row.onHand, row.unit) : <UnknownQuantity />,
  }),
  columnHelper.accessor((row) => quantityValue(row, "reserved"), {
    id: "reserved",
    header: "Reserved",
    sortUndefined: "last",
    meta: quantityMeta,
    cell: ({ row: { original: row } }) =>
      formatStockQuantity(row.reserved, row.unit),
  }),
  columnHelper.accessor((row) => quantityValue(row, "available"), {
    id: "available",
    header: "Available",
    sortUndefined: "last",
    meta: { ...quantityMeta, cellClassName: "tabular-nums font-semibold" },
    cell: ({ row: { original: row } }) =>
      row.countKnown ? (
        formatStockQuantity(row.available, row.unit)
      ) : (
        <UnknownQuantity />
      ),
  }),
  columnHelper.display({
    id: "notes",
    header: "Notes",
    meta: {
      card: "subtitle",
      cellClassName: "whitespace-normal text-xs",
    } satisfies DataGridColumnMeta,
    cell: ({ row: { original: row } }) => (
      <div className="grid gap-0.5">
        {row.holds?.map((hold, i) => (
          <span key={i} className="text-destructive">
            {hold.reason}
            {hold.until ? ` / Until ${hold.until}` : ""}
          </span>
        ))}
        {row.holdsKnown === false && (
          <span className="text-muted-foreground">
            Action holds not checked. Review restrictions before use.
          </span>
        )}
        {!row.originKnown && (
          <span className="text-muted-foreground">Origin not recorded</span>
        )}
      </div>
    ),
  }),
]);

function historyColumns(unit: string | undefined) {
  return historyHelper.columns([
    historyHelper.accessor((entry) => entry.occurredAt, {
      id: "when",
      header: "When",
      meta: { card: "subtitle" } satisfies DataGridColumnMeta,
      cell: ({ row: { original: entry } }) =>
        new Date(entry.occurredAt).toLocaleString(),
    }),
    historyHelper.accessor((entry) => entry.kind.replaceAll("_", " "), {
      id: "movement",
      header: "Movement",
      meta: {
        card: "title",
        cellClassName: "font-medium capitalize",
        filter: true,
        filterAllLabel: "All movements",
      } satisfies DataGridColumnMeta,
    }),
    historyHelper.accessor((entry) => entry.reason, {
      id: "reason",
      header: "Reason",
      meta: { cellClassName: "whitespace-normal" } satisfies DataGridColumnMeta,
      cell: ({ row: { original: entry } }) =>
        entry.reason || (
          <span className="text-muted-foreground">No reason recorded</span>
        ),
    }),
    historyHelper.accessor((entry) => parseStockQuantity(entry.quantity) ?? undefined, {
      id: "quantity",
      header: "Quantity",
      sortUndefined: "last",
      meta: quantityMeta,
      cell: ({ row: { original: entry } }) =>
        formatStockQuantity(entry.quantity, unit, { signed: true }),
    }),
    historyHelper.display({
      id: "links",
      header: "Source",
      cell: ({ row: { original: entry } }) => {
        const href = sourceHref(entry);
        return (
          <DataGridCellAction className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {href && (
              <Link className="underline" href={href}>
                Open {entry.sourceType.replaceAll("_", " ")}
              </Link>
            )}
            {entry.hiveId && (
              <Link className="underline" href={`/yard/hives/${entry.hiveId}`}>
                Hive record
              </Link>
            )}
          </DataGridCellAction>
        );
      },
    }),
  ]);
}

export function StockWorkspace({
  category = "equipment",
  itemId,
}: {
  category?: string;
  itemId?: string;
}) {
  const access = useAccessProfile();
  const query = useSearchParams();
  const pathname = usePathname();
  const location = query.get("locationId") ?? "any";
  const condition = query.get("condition") ?? "any";
  const lot = query.get("lotId") ?? "any";
  const hive = query.get("hiveId") ?? "any";
  const harvest = query.get("harvestLotId") ?? "any";
  const scoped = [location, condition, lot, hive, harvest].some(
    (value) => value !== "any",
  );
  const [showEmpty, setShowEmpty] = useStoredFlag(
    `atlas.stock.showEmpty.${itemId ? "item" : category}`,
    false,
  );
  const stock = useQuery({
    queryKey: [
      "stock",
      itemId ?? category,
      location,
      condition,
      lot,
      hive,
      harvest,
    ],
    enabled: access.data?.isAdmin === true,
    queryFn: async () => {
      const params = {
        ...(!itemId ? { kind: kinds[category] } : {}),
        locationId: location,
        condition,
        lotId: lot,
        hiveId: hive,
        harvestLotId: harvest,
      };
      const result = await api.getWithMeta<StockRead>(
        itemId ? `/stock/${itemId}` : "/stock",
        { params },
      );
      if (!itemId && category === "finished") {
        const products = await api.getWithMeta<StockRead>("/stock", {
          params: { ...params, kind: "catalog_product" },
        });
        const stale =
          result.meta.cache === "stale" ||
          products.meta.cache === "stale" ||
          result.data.freshness.stale ||
          products.data.freshness.stale;
        return {
          ...result.data,
          rows: [...result.data.rows, ...products.data.rows],
          freshness: stale
            ? { stale: true, origin: "cache" }
            : result.data.freshness,
        };
      }
      return {
        ...result.data,
        freshness:
          result.meta.cache === "stale"
            ? { stale: true, origin: "cache" }
            : result.data.freshness,
      };
    },
  });
  const allRows = stock.data?.rows ?? EMPTY_ROWS;
  const kind = allRows[0]?.kind;
  const unit = allRows[0]?.unit;
  const actionCategory = itemId
    ? kind === "equipment"
      ? "equipment"
      : kind === "honey_bulk"
        ? "bulk"
        : "finished"
    : category;
  const emptyCount = React.useMemo(
    () => allRows.filter(isEmptyStockRow).length,
    [allRows],
  );
  const rows = React.useMemo(
    () => (showEmpty ? allRows : allRows.filter((row) => !isEmptyStockRow(row))),
    [allRows, showEmpty],
  );
  const table = useTable({
    features: dataGridFeatures,
    columns: stockColumns,
    data: rows,
  });
  const history = stock.data?.history ?? EMPTY_HISTORY;
  const movementColumns = React.useMemo(() => historyColumns(unit), [unit]);
  const historyTable = useTable({
    features: dataGridFeatures,
    columns: movementColumns,
    data: history,
  });

  const recordName = allRows[0]?.itemName;
  usePageTitle(itemId ? `${recordName ?? "Stock item"} · Stock` : undefined);

  if (access.isPending) return <p>Loading access...</p>;
  if (!access.data?.isAdmin)
    return <p>Stock is available to operation administrators.</p>;
  return (
    <div className={itemId ? "atlas-workspace" : "grid gap-4"}>
      {itemId ? (
        <header className="atlas-heading">
          <div>
            <h1>{recordName ?? "Stock item"}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Physical stock, commitments, and what is available, in the same
              location and unit.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link
              href={
                actionCategory === "equipment"
                  ? "/equipment"
                  : actionCategory === "bulk"
                    ? "/production/lots"
                    : "/production/jars"
              }
            >
              {actionCategory === "equipment"
                ? "Equipment"
                : actionCategory === "bulk"
                  ? "Manage lots"
                  : "Bottling"}
            </Link>
          </Button>
        </header>
      ) : null}
      {scoped && (
        <p className="text-xs text-muted-foreground">
          Showing one scope of this stock.{" "}
          <Link className="underline" href={pathname}>
            Show every location and lot
          </Link>
        </p>
      )}
      {stock.isPending ? (
        <p role="status">Loading stock...</p>
      ) : stock.isError ? (
        <div role="alert">
          Could not load stock.{" "}
          <Button variant="outline" onClick={() => stock.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {stock.data?.freshness.stale ? "Stale · cached" : "Updated"}
            {stock.data?.asOf ? ` ${clock(stock.data.asOf)}` : ""}
            {stock.data?.freshness.stale
              ? " — connect and refresh before acting"
              : ""}
            {" · "}
            <button className="underline" onClick={() => stock.refetch()}>
              Refresh
            </button>
          </p>
          <div className="overflow-hidden rounded-xl border bg-card">
            <DataGrid
              table={table}
              aria-label="Stock"
              searchPlaceholder="Item, lot, or location… (press / to focus)"
              toolbar={
                <label className="inline-flex shrink-0 items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={showEmpty}
                    onChange={(event) => setShowEmpty(event.target.checked)}
                    className="size-4 accent-primary"
                  />
                  Show empty{emptyCount > 0 ? ` (${emptyCount})` : ""}
                </label>
              }
              emptyMessage={
                allRows.length > 0
                  ? `Nothing on hand. ${emptyCount} empty ${emptyCount === 1 ? "row is" : "rows are"} hidden; tick Show empty to list ${emptyCount === 1 ? "it" : "them"}.`
                  : "No stock matches this scope. Record a count or production activity to establish stock."
              }
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Available = on hand minus reserved. Holds appear separately.
            Reservations belong to orders; use Sales to change a commitment.
          </p>
          {itemId && (
            <section>
              <h2 className="mb-3 text-lg font-semibold">Movement history</h2>
              <div className="overflow-hidden rounded-xl border bg-card">
                <DataGrid
                  table={historyTable}
                  aria-label="Movement history"
                  listenOnWindow={false}
                  searchable={history.length > 0}
                  emptyMessage="No recorded movements in this scope."
                />
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
