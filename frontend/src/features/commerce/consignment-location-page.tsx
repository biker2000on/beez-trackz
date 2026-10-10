"use client";

/**
 * The bike shop page.
 *
 * Three things happen here and nowhere else: jars go out (a transfer, which
 * earns nothing), the shop reports what sold and hands over money (one action,
 * because they always arrive together), and unsold jars come home.
 *
 * "Record their report" is deliberately one dialog taking counts AND payment.
 * Splitting them was the old failure mode: the sale existed with no money
 * against it, or the money arrived with nothing saying which jars it was for.
 *
 * Everything on the shelf is tracked by varietal. A shop holding twelve
 * Sourwood quarts and five Wildflower quarts has two shelf rows, is sent stock
 * lot by lot, reports sales lot by lot, and hands jars back lot by lot — so
 * the honey ledger keeps knowing which harvest each jar belonged to. The one
 * escape hatch is "Any lot (oldest first)" on a transfer, for an operator who
 * genuinely does not care which lot goes: the server picks.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createColumnHelper,
  useTable,
} from "@tanstack/react-table";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Store,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShortcutForm } from "@/components/ui/shortcut-form";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
  dataGridFeatures,
} from "@/components/ui/data-grid";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, formatMoney, todayISO } from "@/features/honey/format";
import { ApiError } from "@/lib/api";

import { consignmentTerms, StockLocationDialog } from "./stock-location-form";
import {
  useRecordStockSettlement,
  useReverseStockMovement,
  useStockInventory,
  useStockLocationDetail,
  useStockReturn,
  useStockTransfer,
  useUpdateStockPrices,
  useVoidStockSettlement,
  type StockInventoryLot,
  type StockInventoryRow,
  type StockLocation,
  type StockLocationDetail,
  type StockLocationPrice,
  type StockLotRef,
  type StockMovementLine,
  type StockSettlementLine,
  type StockSettlementLineBody,
  type StockShelfRow,
  type StockTransferLineBody,
} from "./stock-locations-api";

/** SKU identity that works for both jar sizes and catalog products. */
function skuKey(row: { jarSizeId: string | null; productId: string | null }) {
  return row.jarSizeId ? `jar:${row.jarSizeId}` : `product:${row.productId}`;
}

function skuBody(row: {
  jarSizeId: string | null;
  productId: string | null;
}): Pick<StockTransferLineBody, "jarSizeId" | "productId"> {
  return row.jarSizeId
    ? { jarSizeId: row.jarSizeId }
    : { productId: row.productId ?? undefined };
}

/** A shelf row's identity: the SKU and the lot it came from. */
function lotKey(row: {
  jarSizeId: string | null;
  productId: string | null;
  harvestLotId: string | null;
}) {
  return `${skuKey(row)}|${row.harvestLotId ?? ""}`;
}

const NO_VARIETAL = "No varietal";

/** The group a shelf row sits under: its varietal, or the unattributed bucket. */
function varietalGroup(row: StockLotRef): string {
  return row.varietalName ?? NO_VARIETAL;
}

/** "Sourwood · 2025-SW", or whichever half is known. */
function lotLabel(row: StockLotRef): string {
  if (row.varietalName && row.lotCode) return `${row.varietalName} · ${row.lotCode}`;
  return row.varietalName ?? row.lotCode ?? "No lot";
}

/** "Quart · Sourwood · 2025-SW": how a shelf row is named in a form control. */
function shelfRowName(row: StockShelfRow): string {
  return `${row.label} · ${lotLabel(row)}`;
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a.localeCompare(b);
}

/** Varietal, then lot, then size — the order the shelf and every dialog use. */
function sortShelf<T extends StockShelfRow>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      compareNullable(a.varietalName, b.varietalName) ||
      compareNullable(a.lotCode, b.lotCode) ||
      a.label.localeCompare(b.label),
  );
}

// --- grid plumbing ---------------------------------------------------------

const gridFeatures = dataGridFeatures;

const rightAligned: DataGridColumnMeta = {
  align: "right",
  cellClassName: "tabular-nums",
};

type UnsettledRow = StockLocationDetail["unsettled"][number];
type SettlementRow = StockLocationDetail["settlements"][number];
type MovementRow = StockLocationDetail["movements"][number];

const shelfHelper = createColumnHelper<typeof gridFeatures, StockShelfRow>();
const unsettledHelper = createColumnHelper<typeof gridFeatures, UnsettledRow>();
const settlementHelper = createColumnHelper<typeof gridFeatures, SettlementRow>();
const movementHelper = createColumnHelper<typeof gridFeatures, MovementGridRow>();

const shelfColumns = shelfHelper.columns([
  shelfHelper.display({
    id: "varietal",
    header: "Varietal",
    meta: { cellClassName: "font-medium" } satisfies DataGridColumnMeta,
    cell: ({ row }) => row.original.varietalName ?? "—",
  }),
  shelfHelper.display({
    id: "lot",
    header: "Lot",
    meta: { cellClassName: "text-muted-foreground" } satisfies DataGridColumnMeta,
    cell: ({ row }) => row.original.lotCode ?? "—",
  }),
  shelfHelper.display({
    id: "size",
    header: "Size",
    cell: ({ row }) => row.original.label,
  }),
  shelfHelper.display({
    id: "onShelf",
    header: "On hand",
    meta: {
      align: "right",
      cellClassName: "font-semibold tabular-nums",
    } satisfies DataGridColumnMeta,
    cell: ({ row }) => row.original.onHand,
  }),
  shelfHelper.display({
    id: "yourPrice",
    header: "Your price",
    meta: {
      align: "right",
      cellClassName: "font-medium tabular-nums",
    } satisfies DataGridColumnMeta,
    cell: ({ row }) =>
      row.original.owedPrice != null ? formatMoney(row.original.owedPrice) : "—",
  }),
  shelfHelper.display({
    id: "theirPrice",
    header: "Their price",
    meta: {
      align: "right",
      cellClassName: "tabular-nums text-muted-foreground",
    } satisfies DataGridColumnMeta,
    cell: ({ row }) =>
      row.original.unitPrice != null ? formatMoney(row.original.unitPrice) : "—",
  }),
]);

function ShelfTable({ rows }: { rows: StockShelfRow[] }) {
  const data = React.useMemo(() => sortShelf(rows), [rows]);
  const table = useTable({
    features: gridFeatures,
    columns: shelfColumns,
    data,
    getRowId: (row) => lotKey(row),
  });
  return (
    <DataGrid
      table={table}
      aria-label="Stock on shelf"
      getRowGroup={varietalGroup}
    />
  );
}

const unsettledColumns = unsettledHelper.columns([
  unsettledHelper.display({
    id: "date",
    header: "Date",
    cell: ({ row }) => formatDate(row.original.date),
  }),
  unsettledHelper.display({
    id: "order",
    header: "Order",
    cell: ({ row }) => (
      <DataGridCellAction className="inline-block">
        <Link
          className="underline underline-offset-2"
          href={`/sales/${row.original.id}`}
        >
          {row.original.orderNumber ?? "View"}
        </Link>
      </DataGridCellAction>
    ),
  }),
  unsettledHelper.display({
    id: "invoiced",
    header: "Invoiced",
    meta: rightAligned,
    cell: ({ row }) => formatMoney(row.original.totalAmount),
  }),
  unsettledHelper.display({
    id: "collected",
    header: "Collected",
    meta: rightAligned,
    cell: ({ row }) => formatMoney(row.original.amountPaid),
  }),
  unsettledHelper.display({
    id: "balance",
    header: "Balance",
    meta: {
      align: "right",
      cellClassName:
        "font-semibold tabular-nums text-amber-700 dark:text-amber-400",
    } satisfies DataGridColumnMeta,
    cell: ({ row }) => formatMoney(row.original.balanceDue),
  }),
]);

function UnsettledTable({ rows }: { rows: UnsettledRow[] }) {
  const router = useRouter();
  const data = React.useMemo(() => rows, [rows]);
  const table = useTable({
    features: gridFeatures,
    columns: unsettledColumns,
    data,
    getRowId: (row) => row.id,
  });
  return (
    <DataGrid
      table={table}
      aria-label="Reported sold, not yet paid"
      listenOnWindow={false}
      onRowActivate={(row) => router.push(`/sales/${row.id}`)}
    />
  );
}

export function ConsignmentLocationPage({ locationId }: { locationId: string }) {
  const detail = useStockLocationDetail(locationId);
  const [sendOpen, setSendOpen] = React.useState(false);
  const [returnOpen, setReturnOpen] = React.useState(false);
  const [reportOpen, setReportOpen] = React.useState(false);
  const [termsOpen, setTermsOpen] = React.useState(false);
  const [pricesOpen, setPricesOpen] = React.useState(false);

  if (detail.isPending) return <Skeleton className="h-96 w-full" />;
  if (detail.isError) {
    return (
      <div className="grid justify-items-center gap-3 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          {detail.error instanceof ApiError && detail.error.status === 404
            ? "That location no longer exists."
            : "Could not load this location."}
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/sales/consignment">Back to consignment</Link>
        </Button>
      </div>
    );
  }

  const data: StockLocationDetail = detail.data;
  const location = data.location;
  const unitsOnShelf = data.shelf.reduce((sum, row) => sum + row.onHand, 0);
  const varietalsOnShelf = new Set(
    data.shelf.filter((row) => row.onHand > 0).map(varietalGroup),
  ).size;
  const owed = data.unsettled.reduce((sum, sale) => sum + sale.balanceDue, 0);

  return (
    <div className="mx-auto grid w-full max-w-none gap-5">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/sales/consignment">
            <ArrowLeft />
            Consignment
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold tracking-tight">
            <Store className="size-5 shrink-0 text-primary" />
            <span className="min-w-0 truncate">{location.name}</span>
            {location.isConsignment && <Badge variant="accent">Consignment</Badge>}
            {!location.isActive && <Badge variant="outline">inactive</Badge>}
          </h1>
          <p className="text-sm text-muted-foreground">
            {consignmentTerms(location)} · settles{" "}
            {location.settlementCadence.replaceAll("_", " ")}
            {location.customerName ? ` · ${location.customerName}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setTermsOpen(true)}>
            <Pencil />
            Edit terms
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setSendOpen(true)}>
            <Send />
            Send stock
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setReturnOpen(true)}
            disabled={unitsOnShelf === 0}
          >
            <Undo2 />
            Bring stock home
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => setReportOpen(true)}
            disabled={unitsOnShelf === 0}
          >
            <ClipboardCheck />
            Record their report
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="On shelf"
          value={String(unitsOnShelf)}
          detail={
            varietalsOnShelf > 0
              ? `${varietalsOnShelf} varietal${varietalsOnShelf === 1 ? "" : "s"}`
              : undefined
          }
        />
        <Stat label="Unsettled" value={formatMoney(owed)} />
        <Stat
          label="Reports"
          value={String(data.settlements.filter((row) => !row.voidedAt).length)}
        />
        <Stat
          label="Last report"
          value={
            data.settlements.find((row) => !row.voidedAt)?.periodEnd
              ? formatDate(data.settlements.find((row) => !row.voidedAt)!.periodEnd)
              : "—"
          }
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Stock on shelf</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {data.shelf.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              Nothing here right now. Send stock to put jars on their shelf.
            </p>
          ) : (
            <ShelfTable rows={data.shelf} />
          )}
        </CardContent>
      </Card>

      {data.prices && (
        <PricesCard
          location={location}
          prices={data.prices}
          onEdit={() => setPricesOpen(true)}
        />
      )}

      {data.unsettled.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Reported sold, not yet paid</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <UnsettledTable rows={data.unsettled} />
          </CardContent>
        </Card>
      )}

      <SettlementHistory settlements={data.settlements} />
      <MovementHistory movements={data.movements} />

      <SendStockDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        location={location}
      />
      <BringHomeDialog
        open={returnOpen}
        onOpenChange={setReturnOpen}
        location={location}
        shelf={data.shelf}
      />
      <RecordReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        location={location}
        shelf={data.shelf}
      />
      <StockLocationDialog
        open={termsOpen}
        onOpenChange={setTermsOpen}
        location={location}
      />
      {data.prices && (
        <EditPricesDialog
          open={pricesOpen}
          onOpenChange={setPricesOpen}
          location={location}
          prices={data.prices}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-md bg-muted p-3">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="text-lg font-bold tabular-nums">{value}</p>
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

// --- per-store prices ------------------------------------------------------

const priceHelper = createColumnHelper<typeof gridFeatures, StockLocationPrice>();

/** What "your price to them" falls back to when this store has none set. */
function wholesaleFallback(row: StockLocationPrice): { value: number; source: string } {
  return row.priceListPrice != null
    ? { value: row.priceListPrice, source: "price list" }
    : { value: row.listPrice, source: "list price" };
}

/** A set price, or the fallback in muted text naming where it comes from. */
function PriceOrFallback({
  value,
  fallback,
}: {
  value: number | null;
  fallback: { value: number; source: string };
}) {
  if (value != null) return <>{formatMoney(value)}</>;
  return (
    <span className="text-muted-foreground">
      {formatMoney(fallback.value)}
      <span className="ml-1 text-xs">({fallback.source})</span>
    </span>
  );
}

/** One sentence on which of the two prices decides what this store owes. */
function pricesExplainer(location: StockLocation): string {
  switch (location.priceBasis) {
    case "wholesale_list":
      return "You are owed your price for each jar they sell, whatever they charge. Their shelf price is kept for reference.";
    case "commission":
      return `You are owed their shelf price less their ${consignmentTerms(location)}. Your price to them only applies on a wholesale basis.`;
    default:
      return "You are owed their full shelf price. Your price to them only applies on a wholesale basis.";
  }
}

function PricesCard({
  location,
  prices,
  onEdit,
}: {
  location: StockLocation;
  prices: StockLocationPrice[];
  onEdit: () => void;
}) {
  const data = React.useMemo(
    () => [...prices].sort((a, b) => a.label.localeCompare(b.label)),
    [prices],
  );
  const columns = React.useMemo(
    () =>
      priceHelper.columns([
        priceHelper.display({
          id: "item",
          header: "Item",
          meta: { cellClassName: "font-medium" } satisfies DataGridColumnMeta,
          cell: ({ row }) => row.original.label,
        }),
        priceHelper.display({
          id: "wholesale",
          header: "Your price to them",
          meta: rightAligned,
          cell: ({ row }) => (
            <PriceOrFallback
              value={row.original.wholesalePrice}
              fallback={wholesaleFallback(row.original)}
            />
          ),
        }),
        priceHelper.display({
          id: "shelf",
          header: "Their shelf price",
          meta: rightAligned,
          cell: ({ row }) => (
            <PriceOrFallback
              value={row.original.shelfPrice}
              fallback={{ value: row.original.listPrice, source: "list price" }}
            />
          ),
        }),
      ]),
    [],
  );
  const table = useTable({
    features: gridFeatures,
    columns,
    data,
    getRowId: (row) => skuKey(row),
  });
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 pb-3">
        <div className="grid gap-1">
          <CardTitle className="text-base">Prices</CardTitle>
          <p className="text-xs text-muted-foreground">{pricesExplainer(location)}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onEdit}
          disabled={prices.length === 0}
        >
          <Pencil />
          Edit prices
        </Button>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {prices.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            Nothing consignable to price yet.
          </p>
        ) : (
          <DataGrid table={table} aria-label="Prices" listenOnWindow={false} />
        )}
      </CardContent>
    </Card>
  );
}

interface PriceEntry {
  wholesale: string;
  shelf: string;
}

function moneyText(value: number | null): string {
  return value != null ? value.toFixed(2) : "";
}

/** Blank is "no override" (null); anything else must be a non-negative amount. */
function parseMoneyEntry(text: string): { value: number | null; valid: boolean } {
  const trimmed = text.trim();
  if (trimmed === "") return { value: null, valid: true };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return { value: null, valid: false };
  return { value: Math.round(value * 100) / 100, valid: true };
}

function EditPricesDialog({
  open,
  onOpenChange,
  location,
  prices,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location: StockLocation;
  prices: StockLocationPrice[];
}) {
  const save = useUpdateStockPrices(location.id);
  const [entries, setEntries] = React.useState<Record<string, PriceEntry>>({});

  React.useEffect(() => {
    if (!open) return;
    // Load the saved prices each time the dialog opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEntries(
      Object.fromEntries(
        prices.map((row) => [
          skuKey(row),
          { wholesale: moneyText(row.wholesalePrice), shelf: moneyText(row.shelfPrice) },
        ]),
      ),
    );
    // `prices` is deliberately left out: a refetch must not wipe typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const data = React.useMemo(
    () => [...prices].sort((a, b) => a.label.localeCompare(b.label)),
    [prices],
  );

  let invalid: string | null = null;
  const body = data.map((row) => {
    const entry = entries[skuKey(row)] ?? { wholesale: "", shelf: "" };
    const wholesale = parseMoneyEntry(entry.wholesale);
    const shelf = parseMoneyEntry(entry.shelf);
    if (!wholesale.valid || !shelf.valid) {
      invalid ??= `${row.label}: prices must be blank or an amount of zero or more.`;
    }
    return {
      jarSizeId: row.jarSizeId,
      productId: row.productId,
      wholesalePrice: wholesale.value,
      shelfPrice: shelf.value,
    };
  });
  const overrides = body.filter(
    (row) => row.wholesalePrice != null || row.shelfPrice != null,
  ).length;
  const error = save.error instanceof Error ? save.error.message : null;

  const columns = React.useMemo(() => {
    function priceCell(
      field: keyof PriceEntry,
      label: (row: StockLocationPrice) => string,
      placeholder: (row: StockLocationPrice) => string,
    ) {
      return function PriceCell({
        row: { original: row },
      }: {
        row: { original: StockLocationPrice };
      }) {
        const key = skuKey(row);
        const entry = entries[key] ?? { wholesale: "", shelf: "" };
        return (
          <DataGridCellAction>
            <Input
              aria-label={label(row)}
              type="number"
              min="0"
              step="0.01"
              value={entry[field]}
              placeholder={placeholder(row)}
              onChange={(event) =>
                setEntries((current) => ({
                  ...current,
                  [key]: {
                    ...(current[key] ?? { wholesale: "", shelf: "" }),
                    [field]: event.target.value,
                  },
                }))
              }
            />
          </DataGridCellAction>
        );
      };
    }
    return priceHelper.columns([
      priceHelper.display({
        id: "item",
        header: "Item",
        meta: { cellClassName: "font-medium" } satisfies DataGridColumnMeta,
        cell: ({ row }) => row.original.label,
      }),
      priceHelper.display({
        id: "wholesale",
        header: "Your price to them ($)",
        meta: { headClassName: "w-32" } satisfies DataGridColumnMeta,
        cell: priceCell(
          "wholesale",
          (row) => `${row.label} your price to them`,
          (row) => wholesaleFallback(row).value.toFixed(2),
        ),
      }),
      priceHelper.display({
        id: "shelf",
        header: "Their shelf price ($)",
        meta: { headClassName: "w-32" } satisfies DataGridColumnMeta,
        cell: priceCell(
          "shelf",
          (row) => `${row.label} their shelf price`,
          (row) => row.listPrice.toFixed(2),
        ),
      }),
    ]);
  }, [entries]);
  const table = useTable({
    features: gridFeatures,
    columns,
    data,
    getRowId: (row) => skuKey(row),
  });

  function submit() {
    if (invalid || save.isPending) return;
    save.mutate({ prices: body }, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Prices at {location.name}</DialogTitle>
          <DialogDescription>
            {pricesExplainer(location)} Leave a box blank to use the price shown
            in grey (the price list if one is linked, otherwise your list price).
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onSubmitAndReset={submit}
        >
          {(invalid || error) && <ErrorBanner message={invalid ?? error ?? ""} />}
          <div className="overflow-x-auto">
            <DataGrid
              table={table}
              aria-label={`${location.name} prices`}
              listenOnWindow={false}
            />
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {overrides} of {data.length} {data.length === 1 ? "item" : "items"} with a
            price set for this store
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={invalid != null || save.isPending}>
              {save.isPending ? "Saving…" : "Save prices"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// --- send stock ------------------------------------------------------------

/** "Any lot" is the empty string: the line submits no `harvestLotId`. */
const ANY_LOT = "";

interface SendLine {
  id: number;
  sku: string;
  lot: string;
  qty: string;
}

/** A send line's whole-unit count; blank or unevaluated text counts as 0. */
function qtyOf(line: SendLine): number {
  return Math.max(0, Math.trunc(Number(line.qty) || 0));
}

type SendableSku = StockInventoryRow & {
  key: string;
  atHome: number;
  /** Lots of this SKU with something at home; unattributed stock is not listed. */
  homeLots: (StockInventoryLot & { atHome: number })[];
};

function SendStockDialog({
  open,
  onOpenChange,
  location,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location: StockLocation;
}) {
  const inventory = useStockInventory(open);
  const transfer = useStockTransfer(location.id);
  const [date, setDate] = React.useState(todayISO());
  const [lines, setLines] = React.useState<SendLine[]>([]);
  const [notes, setNotes] = React.useState("");
  const nextId = React.useRef(1);

  function blankLine(): SendLine {
    return { id: nextId.current++, sku: "", lot: ANY_LOT, qty: "" };
  }

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLines(open ? [blankLine()] : []);
    if (!open) setNotes("");
  }, [open]);

  const homeId = inventory.data?.locations.find((row) => row.isHome)?.id;
  // Only what is actually at home can be sent: consigned stock is already out.
  const available: SendableSku[] = (inventory.data?.items ?? [])
    .map((row) => ({
      ...row,
      key: skuKey(row),
      atHome: homeId ? (row.byLocation[homeId] ?? 0) : 0,
      homeLots: (row.lots ?? [])
        .map((lot) => ({
          ...lot,
          atHome: homeId ? (lot.byLocation[homeId] ?? 0) : 0,
        }))
        .filter((lot) => lot.harvestLotId != null && lot.atHome > 0)
        .sort(
          (a, b) =>
            compareNullable(a.varietalName, b.varietalName) ||
            compareNullable(a.lotCode, b.lotCode),
        ),
    }))
    .filter((row) => row.atHome > 0);
  const skuByKey = new Map(available.map((row) => [row.key, row]));

  // Every count below is "what is left after the OTHER lines in this dialog",
  // so two lines of Sourwood quarts cannot each claim the same twelve jars.

  /** Units of this SKU the other lines (pinned or any-lot) already take. */
  function skuTakenByOthers(line: SendLine, skuKeyValue: string): number {
    return lines.reduce(
      (sum, other) =>
        other.id !== line.id && other.sku === skuKeyValue
          ? sum + qtyOf(other)
          : sum,
      0,
    );
  }

  /** Units of this (SKU, lot) the other lines pinned to that lot take. */
  function lotTakenByOthers(line: SendLine, skuKeyValue: string, lotId: string): number {
    return lines.reduce(
      (sum, other) =>
        other.id !== line.id && other.sku === skuKeyValue && other.lot === lotId
          ? sum + qtyOf(other)
          : sum,
      0,
    );
  }

  /** What is left at home of a SKU for this line. */
  function skuLeftFor(line: SendLine, sku: SendableSku): number {
    return Math.max(0, sku.atHome - skuTakenByOthers(line, sku.key));
  }

  /** What is left at home of one lot for this line, bounded by the SKU. */
  function lotLeftFor(
    line: SendLine,
    sku: SendableSku,
    lot: SendableSku["homeLots"][number],
  ): number {
    const lotLeft = lot.atHome - lotTakenByOthers(line, sku.key, lot.harvestLotId!);
    return Math.max(0, Math.min(lotLeft, skuLeftFor(line, sku)));
  }

  /** The input's cap: this line's (SKU, lot) after every other line. */
  function capOf(line: SendLine): number {
    const sku = skuByKey.get(line.sku);
    if (!sku) return 0;
    if (line.lot === ANY_LOT) return skuLeftFor(line, sku);
    const lot = sku.homeLots.find((row) => row.harvestLotId === line.lot);
    return lot ? lotLeftFor(line, sku, lot) : 0;
  }

  /** The earlier line this one repeats (same SKU and same lot choice). */
  function duplicateOf(line: SendLine, index: number): number | null {
    if (!line.sku) return null;
    const first = lines.findIndex(
      (other) => other.sku === line.sku && other.lot === line.lot,
    );
    return first >= 0 && first < index ? first + 1 : null;
  }

  const lineErrors = new Map<number, string>();
  lines.forEach((line, index) => {
    const sku = skuByKey.get(line.sku);
    if (!sku) return;
    const repeats = duplicateOf(line, index);
    if (repeats != null) {
      lineErrors.set(
        line.id,
        `Same size and lot as line ${repeats}. Add the units to that line instead.`,
      );
      return;
    }
    const qty = qtyOf(line);
    const cap = capOf(line);
    if (qty > cap) {
      lineErrors.set(
        line.id,
        cap === 0
          ? "None left at home after the other lines."
          : `Only ${cap} left at home after the other lines.`,
      );
    }
  });

  const body: StockTransferLineBody[] = lines.flatMap((line) => {
    const sku = skuByKey.get(line.sku);
    if (!sku) return [];
    const quantity = qtyOf(line);
    if (quantity === 0) return [];
    return [
      {
        ...skuBody(sku),
        quantity,
        ...(line.lot === ANY_LOT ? {} : { harvestLotId: line.lot }),
      },
    ];
  });
  const totalUnits = body.reduce((sum, line) => sum + line.quantity, 0);
  const hasLineErrors = lineErrors.size > 0;

  const error =
    transfer.error instanceof Error ? transfer.error.message : null;

  function patchLine(id: number, patch: Partial<SendLine>) {
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    );
  }

  function submit() {
    if (body.length === 0 || hasLineErrors) return;
    transfer.mutate(
      { date, lines: body, notes: notes.trim() || undefined },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send stock to {location.name}</DialogTitle>
          <DialogDescription>
            A transfer, not a sale. Nothing is earned and nothing is owed until
            they report what sold — but these jars stop counting as available at
            market day. Each line names the lot so their shelf is tracked by
            varietal; &ldquo;any lot&rdquo; lets the ledger pick, oldest first.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onSubmitAndReset={submit}
        >
          {error && <ErrorBanner message={error} />}
          <div className="grid gap-1">
            <Label htmlFor="transfer-date">Date</Label>
            <Input
              id="transfer-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>
          {inventory.isPending ? (
            <Skeleton className="h-32" />
          ) : available.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing is on hand at home to send.
            </p>
          ) : (
            <div className="grid gap-3">
              {lines.map((line, index) => {
                const sku = skuByKey.get(line.sku);
                const cap = capOf(line);
                const n = index + 1;
                const lineError = lineErrors.get(line.id);
                const sizeOptions = available
                  .map((row) => ({ row, left: skuLeftFor(line, row) }))
                  .filter(({ row, left }) => left > 0 || row.key === line.sku);
                // Lots another line already pins are hidden: a second line for
                // the same lot is a duplicate, not a new choice.
                const lotOptions = sku
                  ? sku.homeLots
                      .map((lot) => ({ lot, left: lotLeftFor(line, sku, lot) }))
                      .filter(
                        ({ lot, left }) =>
                          lot.harvestLotId === line.lot ||
                          (left > 0 &&
                            !lines.some(
                              (other) =>
                                other.id !== line.id &&
                                other.sku === line.sku &&
                                other.lot === lot.harvestLotId,
                            )),
                      )
                  : [];
                return (
                  <div key={line.id} data-testid="send-line" className="grid gap-1">
                    <div className="grid gap-2 sm:grid-cols-[1fr_1.4fr_6rem_auto] sm:items-end">
                      <div className="grid gap-1">
                        <Label htmlFor={`send-size-${line.id}`}>Size</Label>
                        <Select
                          value={line.sku}
                          onValueChange={(value) =>
                            patchLine(line.id, { sku: value, lot: ANY_LOT, qty: "" })
                          }
                        >
                          <SelectTrigger
                            id={`send-size-${line.id}`}
                            aria-label={`Line ${n} size`}
                          >
                            <SelectValue placeholder="Pick a size" />
                          </SelectTrigger>
                          <SelectContent>
                            {sizeOptions.map(({ row, left }) => (
                              <SelectItem key={row.key} value={row.key}>
                                {row.label}
                                <span className="text-xs text-muted-foreground">
                                  {` · ${left} left at home`}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-1">
                        <Label htmlFor={`send-lot-${line.id}`}>Varietal / lot</Label>
                        <Select
                          value={line.lot}
                          onValueChange={(value) =>
                            patchLine(line.id, { lot: value === "any" ? ANY_LOT : value })
                          }
                          disabled={!sku}
                        >
                          <SelectTrigger
                            id={`send-lot-${line.id}`}
                            aria-label={`Line ${n} varietal`}
                          >
                            <SelectValue placeholder="Any lot (oldest first)" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="any">
                              Any lot (oldest first)
                              {sku && (
                                <span className="text-xs text-muted-foreground">
                                  {` · ${skuLeftFor(line, sku)} left`}
                                </span>
                              )}
                            </SelectItem>
                            {lotOptions.map(({ lot, left }) => (
                              <SelectItem key={lot.harvestLotId!} value={lot.harvestLotId!}>
                                {lotLabel(lot)}
                                <span className="text-xs text-muted-foreground">
                                  {` · ${left} left`}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-1">
                        <Label htmlFor={`send-qty-${line.id}`}>Units</Label>
                        <Input
                          id={`send-qty-${line.id}`}
                          aria-label={`Line ${n} quantity`}
                          type="number"
                          min="0"
                          max={cap}
                          disabled={!sku}
                          value={line.qty}
                          placeholder={sku ? `≤ ${cap}` : "0"}
                          aria-invalid={lineError ? true : undefined}
                          aria-describedby={lineError ? `send-error-${line.id}` : undefined}
                          onChange={(event) =>
                            patchLine(line.id, { qty: event.target.value })
                          }
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove line ${n}`}
                        disabled={lines.length === 1}
                        onClick={() =>
                          setLines((current) => current.filter((row) => row.id !== line.id))
                        }
                      >
                        <X />
                      </Button>
                    </div>
                    {lineError && (
                      <p
                        id={`send-error-${line.id}`}
                        role="alert"
                        className="text-xs text-destructive"
                      >
                        Line {n}: {lineError}
                      </p>
                    )}
                  </div>
                );
              })}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setLines((current) => [...current, blankLine()])}
                >
                  <Plus />
                  Add a line
                </Button>
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {totalUnits} {totalUnits === 1 ? "unit" : "units"} leaving home for{" "}
            {location.name}
          </p>
          <div className="grid gap-1">
            <Label htmlFor="transfer-notes">Notes</Label>
            <Textarea
              id="transfer-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={totalUnits === 0 || hasLineErrors || transfer.isPending}
            >
              {transfer.isPending ? "Sending…" : `Send ${totalUnits} units`}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// --- bring stock home ------------------------------------------------------

/**
 * The reverse transfer. There is nothing to choose here: what can come home is
 * exactly what is on their shelf, so the dialog is one count per shelf row
 * (SKU and lot), capped at what is there.
 */
function BringHomeDialog({
  open,
  onOpenChange,
  location,
  shelf,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location: StockLocation;
  shelf: StockShelfRow[];
}) {
  const send = useStockReturn(location.id);
  const [date, setDate] = React.useState(todayISO());
  const [counts, setCounts] = React.useState<Record<string, string>>({});
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => {
    if (open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCounts({});
    setNotes("");
  }, [open]);

  const rows = React.useMemo(
    () => sortShelf(shelf).filter((row) => row.onHand > 0),
    [shelf],
  );

  const lines: StockTransferLineBody[] = rows.flatMap((row) => {
    const key = lotKey(row);
    const quantity = Math.min(
      row.onHand,
      Math.max(0, Math.trunc(Number(counts[key]) || 0)),
    );
    if (quantity === 0) return [];
    return [
      {
        ...skuBody(row),
        quantity,
        ...(row.harvestLotId ? { harvestLotId: row.harvestLotId } : {}),
      },
    ];
  });
  const totalUnits = lines.reduce((sum, line) => sum + line.quantity, 0);
  const error = send.error instanceof Error ? send.error.message : null;

  function submit() {
    if (lines.length === 0) return;
    send.mutate(
      { date, lines, notes: notes.trim() || undefined },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Bring stock home from {location.name}</DialogTitle>
          <DialogDescription>
            Unsold jars coming back. Nothing is sold and nothing is owed; the
            jars simply count as available at home again, lot by lot.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onSubmitAndReset={submit}
        >
          {error && <ErrorBanner message={error} />}
          <div className="grid gap-1">
            <Label htmlFor="return-date">Date</Label>
            <Input
              id="return-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            {rows.map((row) => {
              const key = lotKey(row);
              return (
                <div key={key} className="flex items-center gap-3">
                  <Label
                    className="min-w-0 flex-1 truncate font-normal"
                    htmlFor={`return-${key}`}
                  >
                    {row.label}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {lotLabel(row)} · {row.onHand} on shelf
                    </span>
                  </Label>
                  <Input
                    id={`return-${key}`}
                    aria-label={`${shelfRowName(row)} coming home`}
                    className="w-24"
                    type="number"
                    min="0"
                    max={row.onHand}
                    value={counts[key] ?? ""}
                    placeholder="0"
                    onChange={(event) =>
                      setCounts((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                  />
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {totalUnits} {totalUnits === 1 ? "unit" : "units"} coming home ·{" "}
            {rows.reduce((sum, row) => sum + row.onHand, 0) - totalUnits} staying on
            their shelf
          </p>
          <div className="grid gap-1">
            <Label htmlFor="return-notes">Notes</Label>
            <Textarea
              id="return-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={totalUnits === 0 || send.isPending}>
              {send.isPending ? "Returning…" : `Bring ${totalUnits} units home`}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// --- record their report ---------------------------------------------------

interface ReportRow {
  sold: string;
  returned: string;
  price: string;
  count: string;
}

const emptyReportRow: ReportRow = { sold: "", returned: "", price: "", count: "" };

/** First and last day of the month a date falls in, as YYYY-MM-DD. */
function monthBounds(iso: string): { start: string; end: string } {
  const [year, month] = iso.slice(0, 7).split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = String(month).padStart(2, "0");
  return {
    start: `${year}-${pad}-01`,
    end: `${year}-${pad}-${String(last).padStart(2, "0")}`,
  };
}

/** The shelf price a report line uses: what was typed, else the store's. */
function reportShelfPrice(row: StockShelfRow, entry: ReportRow): number {
  return entry.price.trim() === "" ? (row.unitPrice ?? 0) : Number(entry.price) || 0;
}

/**
 * What the operator is owed per unit sold on a report line. A wholesale store
 * owes your price whatever it charged; commission and retail follow the shelf
 * price actually charged.
 */
function owedPerUnit(
  row: StockShelfRow,
  entry: ReportRow,
  location: StockLocation,
  commissionRate: number,
): number {
  if (location.priceBasis === "wholesale_list" && row.owedPrice != null) {
    return row.owedPrice;
  }
  return reportShelfPrice(row, entry) * (1 - commissionRate);
}

function RecordReportDialog({
  open,
  onOpenChange,
  location,
  shelf,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location: StockLocation;
  shelf: StockShelfRow[];
}) {
  const settle = useRecordStockSettlement(location.id);
  const bounds = monthBounds(todayISO());
  const [periodStart, setPeriodStart] = React.useState(bounds.start);
  const [periodEnd, setPeriodEnd] = React.useState(bounds.end);
  const [reportedAt, setReportedAt] = React.useState(todayISO());
  const [payment, setPayment] = React.useState("check");
  const [amountPaid, setAmountPaid] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [rows, setRows] = React.useState<Record<string, ReportRow>>({});

  React.useEffect(() => {
    if (open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRows({});

    setAmountPaid("");

    setNotes("");
  }, [open]);

  const commissionRate =
    location.priceBasis === "commission" ? (location.commissionBps ?? 0) / 10000 : 0;

  const wholesale = location.priceBasis === "wholesale_list";

  const reportData = React.useMemo(() => sortShelf(shelf), [shelf]);

  const lines: StockSettlementLineBody[] = [];
  let owed = 0;
  let overCount: string | null = null;
  for (const row of reportData) {
    const key = lotKey(row);
    const entry = rows[key] ?? emptyReportRow;
    const sold = Math.max(0, Math.trunc(Number(entry.sold) || 0));
    const returned = Math.max(0, Math.trunc(Number(entry.returned) || 0));
    const price = reportShelfPrice(row, entry);
    const count = entry.count.trim() === "" ? undefined : Math.max(0, Number(entry.count) || 0);
    if (sold === 0 && returned === 0 && count === undefined) continue;
    if (sold + returned > row.onHand) {
      overCount = `${row.varietalName ?? "Unattributed"} ${row.label}${
        row.lotCode ? ` (lot ${row.lotCode})` : ""
      }: ${sold + returned} accounted for, but only ${row.onHand} are on their shelf.`;
    }
    lines.push({
      ...skuBody(row),
      ...(row.harvestLotId ? { harvestLotId: row.harvestLotId } : {}),
      quantitySold: sold,
      quantityReturned: returned,
      unitPrice: entry.price.trim() === "" ? undefined : price,
      countOnShelf: count,
    });
    // Mirrors the server's split so the operator sees the cheque total before
    // sending; the server recomputes it in exact cents.
    owed += sold * owedPerUnit(row, entry, location, commissionRate);
  }
  owed = Math.round(owed * 100) / 100;

  const paidValue = amountPaid.trim() === "" ? owed : Number(amountPaid) || 0;
  const overpaid = paidValue > owed;
  const error = settle.error instanceof Error ? settle.error.message : null;
  const valid = lines.length > 0 && !overCount && !overpaid;

  const reportColumns = React.useMemo(() => {
    function numberCell(
      field: keyof ReportRow,
      label: (row: StockShelfRow) => string,
      extra: (row: StockShelfRow) => React.ComponentProps<typeof Input>,
    ) {
      return function ReportCell({
        row: { original: row },
      }: {
        row: { original: StockShelfRow };
      }) {
        const key = lotKey(row);
        const entry = rows[key] ?? emptyReportRow;
        return (
          <DataGridCellAction>
            <Input
              aria-label={label(row)}
              type="number"
              min="0"
              value={entry[field]}
              onChange={(event) =>
                setRows((current) => ({
                  ...current,
                  [key]: {
                    ...(current[key] ?? emptyReportRow),
                    [field]: event.target.value,
                  },
                }))
              }
              {...extra(row)}
            />
          </DataGridCellAction>
        );
      };
    }
    return shelfHelper.columns([
      shelfHelper.display({
        id: "varietal",
        header: "Varietal",
        meta: { cellClassName: "font-medium" } satisfies DataGridColumnMeta,
        cell: ({ row }) => row.original.varietalName ?? "—",
      }),
      shelfHelper.display({
        id: "lot",
        header: "Lot",
        meta: { cellClassName: "text-muted-foreground" } satisfies DataGridColumnMeta,
        cell: ({ row }) => row.original.lotCode ?? "—",
      }),
      shelfHelper.display({
        id: "size",
        header: "Size",
        cell: ({ row }) => row.original.label,
      }),
      shelfHelper.display({
        id: "shelf",
        header: "Shelf",
        meta: rightAligned,
        cell: ({ row }) => row.original.onHand,
      }),
      shelfHelper.display({
        id: "sold",
        header: "Sold",
        meta: { headClassName: "w-20" } satisfies DataGridColumnMeta,
        cell: numberCell(
          "sold",
          (row) => `${shelfRowName(row)} sold`,
          (row) => ({ max: row.onHand, placeholder: "0" }),
        ),
      }),
      shelfHelper.display({
        id: "returned",
        header: "Back",
        meta: { headClassName: "w-20" } satisfies DataGridColumnMeta,
        cell: numberCell(
          "returned",
          (row) => `${shelfRowName(row)} returned`,
          (row) => ({ max: row.onHand, placeholder: "0" }),
        ),
      }),
      shelfHelper.display({
        id: "price",
        header: "Their price",
        meta: { headClassName: "w-24" } satisfies DataGridColumnMeta,
        cell: numberCell(
          "price",
          (row) => `${shelfRowName(row)} shelf price`,
          (row) => ({
            step: "0.01",
            placeholder: row.unitPrice != null ? row.unitPrice.toFixed(2) : "0.00",
          }),
        ),
      }),
      ...(wholesale
        ? [
            shelfHelper.display({
              id: "yourPrice",
              header: "Your price",
              meta: rightAligned,
              cell: ({ row }) =>
                row.original.owedPrice != null
                  ? formatMoney(row.original.owedPrice)
                  : "—",
            }),
          ]
        : []),
      shelfHelper.display({
        id: "owed",
        header: "Owed",
        meta: {
          align: "right",
          cellClassName: "font-medium tabular-nums",
        } satisfies DataGridColumnMeta,
        cell: ({ row: { original: row } }) => {
          const entry = rows[lotKey(row)] ?? emptyReportRow;
          const sold = Math.max(0, Math.trunc(Number(entry.sold) || 0));
          if (sold === 0) return <span className="text-muted-foreground">—</span>;
          return formatMoney(
            Math.round(sold * owedPerUnit(row, entry, location, commissionRate) * 100) /
              100,
          );
        },
      }),
      shelfHelper.display({
        id: "count",
        header: "Their count",
        meta: { headClassName: "w-24" } satisfies DataGridColumnMeta,
        cell: numberCell(
          "count",
          (row) => `${shelfRowName(row)} counted on shelf`,
          () => ({ placeholder: "—" }),
        ),
      }),
    ]);
  }, [rows, wholesale, location, commissionRate]);
  const reportTable = useTable({
    features: gridFeatures,
    columns: reportColumns,
    data: reportData,
    getRowId: (row) => lotKey(row),
  });

  function submit() {
    if (!valid) return;
    settle.mutate(
      {
        periodStart,
        periodEnd,
        reportedAt,
        lines,
        amountPaid: paidValue,
        paymentMethod: payment,
        notes: notes.trim() || undefined,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Record {location.name}&apos;s report</DialogTitle>
          <DialogDescription>
            What sold, what is coming back, and the cheque — together, one row
            per varietal and lot on their shelf. Revenue is recognised now;
            anything they have not paid stays a balance due on the order. Their
            shelf count is optional: where it disagrees with ours, the
            difference is recorded as shrink at their location.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onSubmitAndReset={submit}
        >
          {(error || overCount || overpaid) && (
            <ErrorBanner
              message={
                overCount ??
                (overpaid
                  ? `The payment is more than the ${formatMoney(owed)} this report owes.`
                  : (error ?? ""))
              }
            />
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1">
              <Label htmlFor="period-start">Period from</Label>
              <Input
                id="period-start"
                type="date"
                value={periodStart}
                onChange={(event) => setPeriodStart(event.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="period-end">to</Label>
              <Input
                id="period-end"
                type="date"
                value={periodEnd}
                onChange={(event) => setPeriodEnd(event.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="reported-at">Reported on</Label>
              <Input
                id="reported-at"
                type="date"
                value={reportedAt}
                onChange={(event) => setReportedAt(event.target.value)}
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <DataGrid
              table={reportTable}
              aria-label={`${location.name} report lines`}
              listenOnWindow={false}
              getRowGroup={varietalGroup}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1">
              <Label>Payment</Label>
              <Select value={payment} onValueChange={setPayment}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="check">Check</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="venmo">Venmo</SelectItem>
                  <SelectItem value="paypal">PayPal</SelectItem>
                  <SelectItem value="invoice">Invoice (unpaid)</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="amount-paid">Amount received</Label>
              <Input
                id="amount-paid"
                type="number"
                min="0"
                step="0.01"
                value={amountPaid}
                placeholder={owed.toFixed(2)}
                onChange={(event) => setAmountPaid(event.target.value)}
              />
            </div>
            <div className="grid content-end gap-1">
              <span className="text-xs uppercase text-muted-foreground">
                Owed to you
              </span>
              <span className="text-2xl font-bold tabular-nums">
                {formatMoney(owed)}
              </span>
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {lines.reduce((sum, line) => sum + line.quantitySold, 0)} sold ·{" "}
                {lines.reduce((sum, line) => sum + line.quantityReturned, 0)} returned
              </span>
            </div>
          </div>
          {commissionRate > 0 && (
            <p className="text-xs text-muted-foreground">
              {location.name} keeps {(commissionRate * 100).toFixed(2)}% of each
              sale; the figure above is your share.
            </p>
          )}
          {wholesale && (
            <p className="text-xs text-muted-foreground">
              {location.name} pays your price for each jar sold, whatever they
              charged; their price is recorded for reference only. Set your
              price per jar under Prices on this page.
            </p>
          )}
          <div className="grid gap-1">
            <Label htmlFor="report-notes">Notes</Label>
            <Textarea
              id="report-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || settle.isPending}>
              {settle.isPending ? "Recording…" : "Record report"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// --- history ---------------------------------------------------------------

/** Dims a voided/reversed row's content the way the old row-level class did. */
function Dimmed({
  dim,
  className,
  children,
}: {
  dim: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={cnDim(dim, className)}>{children}</span>
  );
}

function cnDim(dim: boolean, className?: string) {
  if (!dim) return className;
  return className ? `${className} opacity-60` : "opacity-60";
}

/** "3 Quart Sourwood sold · 1 Pint Wildflower back" for a report's lines. */
function settlementLineSummary(lines: StockSettlementLine[] | undefined): string {
  if (!lines || lines.length === 0) return "—";
  const parts: string[] = [];
  for (const line of lines) {
    const what = `${line.label}${line.varietalName ? ` ${line.varietalName}` : ""}`;
    if (line.quantitySold > 0) parts.push(`${line.quantitySold} ${what} sold`);
    if (line.quantityReturned > 0) parts.push(`${line.quantityReturned} ${what} back`);
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function SettlementHistory({
  settlements,
}: {
  settlements: StockLocationDetail["settlements"];
}) {
  const voidSettlement = useVoidStockSettlement();
  const data = React.useMemo(() => settlements, [settlements]);
  const columns = React.useMemo(
    () =>
      settlementHelper.columns([
        settlementHelper.display({
          id: "period",
          header: "Period",
          cell: ({ row: { original: row } }) => (
            <Dimmed dim={row.voidedAt != null}>
              {formatDate(row.periodStart)} – {formatDate(row.periodEnd)}
              {row.voidedAt && (
                <Badge variant="outline" className="ml-2">
                  voided
                </Badge>
              )}
            </Dimmed>
          ),
        }),
        settlementHelper.display({
          id: "lines",
          header: "What moved",
          meta: {
            cellClassName: "max-w-md whitespace-normal text-xs text-muted-foreground",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: row } }) => (
            <Dimmed dim={row.voidedAt != null}>
              {settlementLineSummary(row.lines)}
            </Dimmed>
          ),
        }),
        settlementHelper.display({
          id: "owed",
          header: "Owed",
          meta: rightAligned,
          cell: ({ row: { original: row } }) => (
            <Dimmed dim={row.voidedAt != null}>
              {formatMoney(row.amountOwed)}
            </Dimmed>
          ),
        }),
        settlementHelper.display({
          id: "paid",
          header: "Paid",
          meta: rightAligned,
          cell: ({ row: { original: row } }) => (
            <Dimmed dim={row.voidedAt != null}>
              {formatMoney(row.amountPaid)}
            </Dimmed>
          ),
        }),
        settlementHelper.display({
          id: "commission",
          header: "Their cut",
          meta: rightAligned,
          cell: ({ row: { original: row } }) => (
            <Dimmed dim={row.voidedAt != null}>
              {formatMoney(row.commission)}
            </Dimmed>
          ),
        }),
        settlementHelper.display({
          id: "actions",
          header: "",
          meta: { cellClassName: "p-1 text-right" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: row } }) =>
            row.voidedAt ? null : (
              <DataGridCellAction className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={voidSettlement.isPending}
                  onClick={() => voidSettlement.mutate({ id: row.id })}
                >
                  <RotateCcw />
                  Void
                </Button>
              </DataGridCellAction>
            ),
        }),
      ]),
    [voidSettlement],
  );
  const table = useTable({
    features: gridFeatures,
    columns,
    data,
    getRowId: (row) => row.id,
  });
  if (settlements.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Reports</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <DataGrid table={table} aria-label="Reports" listenOnWindow={false} />
      </CardContent>
    </Card>
  );
}

function movementDim(row: MovementRow) {
  return row.isReversal || row.reversedByMovementId != null;
}

/** "lot 2025-SW · Sourwood", or whichever half the movement carries. */
function movementLot(row: {
  lotCode: string | null;
  varietalName: string | null;
}): string | null {
  if (row.lotCode && row.varietalName) return `lot ${row.lotCode} · ${row.varietalName}`;
  if (row.lotCode) return `lot ${row.lotCode}`;
  return row.varietalName;
}

function signed(quantity: number): string {
  return quantity > 0 ? `+${quantity}` : String(quantity);
}

/**
 * A row of the movements grid: an operation, or (when its parent is
 * expanded) one of the lines that operation moved.
 */
interface MovementGridRow {
  key: string;
  movement: MovementRow;
  /** Null on the operation row itself. */
  line: StockMovementLine | null;
  lineCount: number;
  expanded: boolean;
}

function canReverse(row: MovementRow): boolean {
  return !row.isReversal && !row.reversedByMovementId && !row.settlementId;
}

function MovementHistory({
  movements,
}: {
  movements: StockLocationDetail["movements"];
}) {
  const reverse = useReverseStockMovement();
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = React.useState<MovementRow | null>(null);

  const toggle = React.useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const data = React.useMemo<MovementGridRow[]>(
    () =>
      movements.flatMap((movement) => {
        const lines = movement.lines ?? [];
        const lineCount = lines.length;
        const isOpen = lineCount > 1 && expanded.has(movement.id);
        const parent: MovementGridRow = {
          key: movement.id,
          movement,
          line: null,
          lineCount,
          expanded: isOpen,
        };
        if (!isOpen) return [parent];
        return [
          parent,
          ...lines.map((line, index) => ({
            key: `${movement.id}:${index}`,
            movement,
            line,
            lineCount,
            expanded: false,
          })),
        ];
      }),
    [movements, expanded],
  );

  const columns = React.useMemo(
    () =>
      movementHelper.columns([
        movementHelper.display({
          id: "expand",
          header: "",
          meta: { cellClassName: "w-8 p-1" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: row } }) =>
            row.line == null && row.lineCount > 1 ? (
              <DataGridCellAction>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-expanded={row.expanded}
                  aria-label={`${row.expanded ? "Hide" : "Show"} the ${row.lineCount} lines of this ${row.movement.kind}`}
                  onClick={() => toggle(row.movement.id)}
                >
                  {row.expanded ? <ChevronDown /> : <ChevronRight />}
                </Button>
              </DataGridCellAction>
            ) : null,
        }),
        movementHelper.display({
          id: "date",
          header: "Date",
          cell: ({ row: { original: row } }) =>
            row.line ? null : (
              <Dimmed dim={movementDim(row.movement)}>
                {formatDate(row.movement.date)}
              </Dimmed>
            ),
        }),
        movementHelper.display({
          id: "what",
          header: "What",
          meta: { cellClassName: "capitalize" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: row } }) => {
            if (row.line) return null;
            const movement = row.movement;
            return (
              <Dimmed dim={movementDim(movement)}>
                {movement.kind}
                {movement.isReversal && " (reversal)"}
                {movement.counterpartyName && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {movement.quantity > 0 ? "from" : "to"} {movement.counterpartyName}
                  </span>
                )}
              </Dimmed>
            );
          },
        }),
        movementHelper.display({
          id: "item",
          header: "Item",
          cell: ({ row: { original: row } }) => {
            if (row.line) {
              const lot = movementLot(row.line);
              return (
                <Dimmed dim={movementDim(row.movement)} className="pl-6">
                  {row.line.label}
                  {lot && (
                    <span className="ml-2 text-xs text-muted-foreground">{lot}</span>
                  )}
                </Dimmed>
              );
            }
            const movement = row.movement;
            const lot = movementLot(movement);
            if (row.lineCount > 1) {
              // Name what the lines share, if anything: "Quart" when every
              // line is a quart, a lot when every line is the same lot.
              const shared = [
                movement.label && movement.label !== "Mixed" ? movement.label : null,
                lot,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <Dimmed dim={movementDim(movement)}>
                  {row.lineCount} lines
                  {shared && (
                    <span className="ml-2 text-xs text-muted-foreground">{shared}</span>
                  )}
                </Dimmed>
              );
            }
            return (
              <Dimmed dim={movementDim(movement)}>
                {movement.label}
                {lot && (
                  <span className="ml-2 text-xs text-muted-foreground">{lot}</span>
                )}
              </Dimmed>
            );
          },
        }),
        movementHelper.display({
          id: "quantity",
          header: "Qty",
          meta: rightAligned,
          cell: ({ row: { original: row } }) => (
            <Dimmed
              dim={movementDim(row.movement)}
              className={row.line ? "text-muted-foreground" : undefined}
            >
              {signed(row.line ? row.line.quantity : row.movement.quantity)}
            </Dimmed>
          ),
        }),
        movementHelper.display({
          id: "actions",
          header: "",
          meta: { cellClassName: "p-1 text-right" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: row } }) => {
            if (row.line || !canReverse(row.movement)) return null;
            const units = Math.abs(row.movement.quantity);
            const many = row.lineCount > 1;
            return (
              <DataGridCellAction className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={reverse.isPending}
                  title={`Undo this whole ${row.movement.kind} (${units} ${units === 1 ? "unit" : "units"})`}
                  onClick={() => setConfirming(row.movement)}
                >
                  <RotateCcw />
                  {many ? "Reverse all" : "Reverse"}
                </Button>
              </DataGridCellAction>
            );
          },
        }),
      ]),
    [reverse.isPending, toggle],
  );
  const table = useTable({
    features: gridFeatures,
    columns,
    data,
    getRowId: (row) => row.key,
  });
  if (movements.length === 0) return null;

  const confirmUnits = confirming ? Math.abs(confirming.quantity) : 0;
  const confirmLines = confirming?.lines?.length ?? 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Movements</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <DataGrid
          table={table}
          aria-label="Movements"
          listenOnWindow={false}
          onRowActivate={(row) => {
            if (row.line == null && row.lineCount > 1) toggle(row.movement.id);
          }}
          rowProps={(row) =>
            row.line ? { className: "bg-muted/30 text-sm" } : undefined
          }
        />
      </CardContent>
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmLines > 1 ? "Reverse this whole " : "Reverse this "}
              {confirming?.kind ?? "movement"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming
                ? `The ${confirming.kind} from ${formatDate(confirming.date)} moved ${confirmUnits} ${confirmUnits === 1 ? "unit" : "units"}${
                    confirmLines > 1 ? ` across ${confirmLines} lines` : ""
                  }. Reversing records an equal and opposite movement for ${
                    confirmLines > 1 ? "every line" : "it"
                  }; the original stays in the history.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirming) reverse.mutate({ id: confirming.id });
                setConfirming(null);
              }}
            >
              {confirmLines > 1 ? `Reverse all ${confirmUnits} units` : "Reverse"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
