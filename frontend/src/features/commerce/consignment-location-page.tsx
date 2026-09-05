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
  ClipboardCheck,
  Plus,
  RotateCcw,
  Send,
  Store,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";

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

import { consignmentTerms } from "./consignment-page";
import {
  useRecordStockSettlement,
  useReverseStockMovement,
  useStockInventory,
  useStockLocationDetail,
  useStockReturn,
  useStockTransfer,
  useVoidStockSettlement,
  type StockInventoryLot,
  type StockInventoryRow,
  type StockLocation,
  type StockLocationDetail,
  type StockLotRef,
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
const movementHelper = createColumnHelper<typeof gridFeatures, MovementRow>();

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
    id: "price",
    header: "Price",
    meta: rightAligned,
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
          </h1>
          <p className="text-sm text-muted-foreground">
            {consignmentTerms(location)} · settles{" "}
            {location.settlementCadence.replaceAll("_", " ")}
            {location.customerName ? ` · ${location.customerName}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
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

// --- send stock ------------------------------------------------------------

/** "Any lot" is the empty string: the line submits no `harvestLotId`. */
const ANY_LOT = "";

interface SendLine {
  id: number;
  sku: string;
  lot: string;
  qty: string;
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

  /** How many of this line's (SKU, lot) are at home — the input's cap. */
  function capOf(line: SendLine): number {
    const sku = skuByKey.get(line.sku);
    if (!sku) return 0;
    if (line.lot === ANY_LOT) return sku.atHome;
    return sku.homeLots.find((lot) => lot.harvestLotId === line.lot)?.atHome ?? 0;
  }

  const body: StockTransferLineBody[] = lines.flatMap((line) => {
    const sku = skuByKey.get(line.sku);
    if (!sku) return [];
    const quantity = Math.min(capOf(line), Math.max(0, Math.trunc(Number(line.qty) || 0)));
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

  const error =
    transfer.error instanceof Error ? transfer.error.message : null;

  function patchLine(id: number, patch: Partial<SendLine>) {
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    );
  }

  function submit() {
    if (body.length === 0) return;
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
                return (
                  <div
                    key={line.id}
                    data-testid="send-line"
                    className="grid gap-2 sm:grid-cols-[1fr_1.4fr_6rem_auto] sm:items-end"
                  >
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
                          {available.map((row) => (
                            <SelectItem key={row.key} value={row.key}>
                              {row.label}
                              <span className="text-xs text-muted-foreground">
                                {` · ${row.atHome} at home`}
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
                                {` · ${sku.atHome} at home`}
                              </span>
                            )}
                          </SelectItem>
                          {sku?.homeLots.map((lot) => (
                            <SelectItem key={lot.harvestLotId!} value={lot.harvestLotId!}>
                              {lotLabel(lot)}
                              <span className="text-xs text-muted-foreground">
                                {` · ${lot.atHome} at home`}
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
                        placeholder="0"
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
            <Button type="submit" disabled={totalUnits === 0 || transfer.isPending}>
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

  const reportData = React.useMemo(() => sortShelf(shelf), [shelf]);

  const lines: StockSettlementLineBody[] = [];
  let owed = 0;
  let overCount: string | null = null;
  for (const row of reportData) {
    const key = lotKey(row);
    const entry = rows[key] ?? emptyReportRow;
    const sold = Math.max(0, Math.trunc(Number(entry.sold) || 0));
    const returned = Math.max(0, Math.trunc(Number(entry.returned) || 0));
    const price =
      entry.price.trim() === "" ? (row.unitPrice ?? 0) : Number(entry.price) || 0;
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
    owed += sold * price * (1 - commissionRate);
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
        header: "Price",
        meta: { headClassName: "w-24" } satisfies DataGridColumnMeta,
        cell: numberCell(
          "price",
          (row) => `${shelfRowName(row)} shelf price`,
          (row) => ({
            step: "0.01",
            placeholder: row.unitPrice != null ? String(row.unitPrice) : "0.00",
          }),
        ),
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
  }, [rows]);
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
            </div>
          </div>
          {commissionRate > 0 && (
            <p className="text-xs text-muted-foreground">
              {location.name} keeps {(commissionRate * 100).toFixed(2)}% of each
              sale; the figure above is your share.
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
function movementLot(row: MovementRow): string | null {
  if (row.lotCode && row.varietalName) return `lot ${row.lotCode} · ${row.varietalName}`;
  if (row.lotCode) return `lot ${row.lotCode}`;
  return row.varietalName;
}

function MovementHistory({
  movements,
}: {
  movements: StockLocationDetail["movements"];
}) {
  const reverse = useReverseStockMovement();
  const data = React.useMemo(() => movements, [movements]);
  const columns = React.useMemo(
    () =>
      movementHelper.columns([
        movementHelper.display({
          id: "date",
          header: "Date",
          cell: ({ row: { original: row } }) => (
            <Dimmed dim={movementDim(row)}>{formatDate(row.date)}</Dimmed>
          ),
        }),
        movementHelper.display({
          id: "what",
          header: "What",
          meta: { cellClassName: "capitalize" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: row } }) => (
            <Dimmed dim={movementDim(row)}>
              {row.kind}
              {row.isReversal && " (reversal)"}
              {row.counterpartyName && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {row.quantity > 0 ? "from" : "to"} {row.counterpartyName}
                </span>
              )}
            </Dimmed>
          ),
        }),
        movementHelper.display({
          id: "item",
          header: "Item",
          cell: ({ row: { original: row } }) => {
            const lot = movementLot(row);
            return (
              <Dimmed dim={movementDim(row)}>
                {row.label}
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
            <Dimmed dim={movementDim(row)}>
              {row.quantity > 0 ? `+${row.quantity}` : row.quantity}
            </Dimmed>
          ),
        }),
        movementHelper.display({
          id: "actions",
          header: "",
          meta: { cellClassName: "p-1 text-right" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: row } }) =>
            !row.isReversal && !row.reversedByMovementId && !row.settlementId ? (
              <DataGridCellAction className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={reverse.isPending}
                  onClick={() => reverse.mutate({ id: row.id })}
                >
                  <RotateCcw />
                  Reverse
                </Button>
              </DataGridCellAction>
            ) : null,
        }),
      ]),
    [reverse],
  );
  const table = useTable({
    features: gridFeatures,
    columns,
    data,
    getRowId: (row) => row.id,
  });
  if (movements.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Movements</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <DataGrid table={table} aria-label="Movements" listenOnWindow={false} />
      </CardContent>
    </Card>
  );
}
