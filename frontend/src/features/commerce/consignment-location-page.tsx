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
  RotateCcw,
  Send,
  Store,
  TriangleAlert,
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
  useStockTransfer,
  useVoidStockSettlement,
  type StockInventoryRow,
  type StockLocation,
  type StockLocationDetail,
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
    id: "item",
    header: "Item",
    meta: { cellClassName: "font-medium" } satisfies DataGridColumnMeta,
    cell: ({ row }) => row.original.label,
  }),
  shelfHelper.display({
    id: "onShelf",
    header: "On shelf",
    meta: {
      align: "right",
      cellClassName: "font-semibold tabular-nums",
    } satisfies DataGridColumnMeta,
    cell: ({ row }) => row.original.onHand,
  }),
  shelfHelper.display({
    id: "price",
    header: "Shelf price",
    meta: rightAligned,
    cell: ({ row }) =>
      row.original.unitPrice != null ? formatMoney(row.original.unitPrice) : "—",
  }),
]);

function ShelfTable({ rows }: { rows: StockShelfRow[] }) {
  const data = React.useMemo(() => rows, [rows]);
  const table = useTable({
    features: gridFeatures,
    columns: shelfColumns,
    data,
    getRowId: (row) => skuKey(row),
  });
  return <DataGrid table={table} aria-label="Stock on shelf" />;
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
        <Stat label="On shelf" value={String(unitsOnShelf)} />
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
        <CardContent>
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
      <RecordReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        location={location}
        shelf={data.shelf}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted p-3">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="text-lg font-bold tabular-nums">{value}</p>
    </div>
  );
}

// --- send stock ------------------------------------------------------------

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
  const [counts, setCounts] = React.useState<Record<string, string>>({});
  const [notes, setNotes] = React.useState("");

  React.useEffect(() => {
    if (open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCounts({});
     
    setNotes("");
  }, [open]);

  const homeId = inventory.data?.locations.find((row) => row.isHome)?.id;
  // Only what is actually at home can be sent: consigned stock is already out.
  const available: (StockInventoryRow & { atHome: number })[] = (
    inventory.data?.items ?? []
  )
    .map((row) => ({ ...row, atHome: homeId ? (row.byLocation[homeId] ?? 0) : 0 }))
    .filter((row) => row.atHome > 0);

  const lines: StockTransferLineBody[] = available
    .map((row) => ({
      ...skuBody(row),
      quantity: Math.min(row.atHome, Math.max(0, Number(counts[skuKey(row)]) || 0)),
    }))
    .filter((line) => line.quantity > 0);
  const totalUnits = lines.reduce((sum, line) => sum + line.quantity, 0);

  const error =
    transfer.error instanceof Error ? transfer.error.message : null;

  function submit() {
    if (lines.length === 0) return;
    transfer.mutate(
      { date, lines, notes: notes.trim() || undefined },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send stock to {location.name}</DialogTitle>
          <DialogDescription>
            A transfer, not a sale. Nothing is earned and nothing is owed until
            they report what sold — but these jars stop counting as available at
            market day.
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
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
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
            <div className="grid gap-2">
              {available.map((row) => {
                const key = skuKey(row);
                return (
                  <div key={key} className="flex items-center gap-3">
                    <Label className="min-w-0 flex-1 truncate font-normal" htmlFor={`send-${key}`}>
                      {row.label}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {row.atHome} at home
                      </span>
                    </Label>
                    <Input
                      id={`send-${key}`}
                      className="w-24"
                      type="number"
                      min="0"
                      max={row.atHome}
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

  const lines: StockSettlementLineBody[] = [];
  let owed = 0;
  let overCount: string | null = null;
  for (const row of shelf) {
    const key = skuKey(row);
    const entry = rows[key] ?? emptyReportRow;
    const sold = Math.max(0, Math.trunc(Number(entry.sold) || 0));
    const returned = Math.max(0, Math.trunc(Number(entry.returned) || 0));
    const price =
      entry.price.trim() === "" ? (row.unitPrice ?? 0) : Number(entry.price) || 0;
    const count = entry.count.trim() === "" ? undefined : Math.max(0, Number(entry.count) || 0);
    if (sold === 0 && returned === 0 && count === undefined) continue;
    if (sold + returned > row.onHand) {
      overCount = `${row.label}: ${sold + returned} accounted for, but only ${row.onHand} are on their shelf.`;
    }
    lines.push({
      ...skuBody(row),
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

  const reportColumns = React.useMemo(
    () =>
      shelfHelper.columns([
        shelfHelper.display({
          id: "item",
          header: "Item",
          meta: { cellClassName: "font-medium" } satisfies DataGridColumnMeta,
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
          cell: ({ row: { original: row } }) => {
            const key = skuKey(row);
            const entry = rows[key] ?? emptyReportRow;
            return (
              <DataGridCellAction>
                <Input
                  aria-label={`${row.label} sold`}
                  type="number"
                  min="0"
                  max={row.onHand}
                  value={entry.sold}
                  placeholder="0"
                  onChange={(event) =>
                    setRows((current) => ({
                      ...current,
                      [key]: {
                        ...(current[key] ?? emptyReportRow),
                        sold: event.target.value,
                      },
                    }))
                  }
                />
              </DataGridCellAction>
            );
          },
        }),
        shelfHelper.display({
          id: "returned",
          header: "Back",
          meta: { headClassName: "w-20" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: row } }) => {
            const key = skuKey(row);
            const entry = rows[key] ?? emptyReportRow;
            return (
              <DataGridCellAction>
                <Input
                  aria-label={`${row.label} returned`}
                  type="number"
                  min="0"
                  max={row.onHand}
                  value={entry.returned}
                  placeholder="0"
                  onChange={(event) =>
                    setRows((current) => ({
                      ...current,
                      [key]: {
                        ...(current[key] ?? emptyReportRow),
                        returned: event.target.value,
                      },
                    }))
                  }
                />
              </DataGridCellAction>
            );
          },
        }),
        shelfHelper.display({
          id: "price",
          header: "Price",
          meta: { headClassName: "w-24" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: row } }) => {
            const key = skuKey(row);
            const entry = rows[key] ?? emptyReportRow;
            return (
              <DataGridCellAction>
                <Input
                  aria-label={`${row.label} shelf price`}
                  type="number"
                  min="0"
                  step="0.01"
                  value={entry.price}
                  placeholder={
                    row.unitPrice != null ? String(row.unitPrice) : "0.00"
                  }
                  onChange={(event) =>
                    setRows((current) => ({
                      ...current,
                      [key]: {
                        ...(current[key] ?? emptyReportRow),
                        price: event.target.value,
                      },
                    }))
                  }
                />
              </DataGridCellAction>
            );
          },
        }),
        shelfHelper.display({
          id: "count",
          header: "Their count",
          meta: { headClassName: "w-24" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: row } }) => {
            const key = skuKey(row);
            const entry = rows[key] ?? emptyReportRow;
            return (
              <DataGridCellAction>
                <Input
                  aria-label={`${row.label} counted on shelf`}
                  type="number"
                  min="0"
                  value={entry.count}
                  placeholder="—"
                  onChange={(event) =>
                    setRows((current) => ({
                      ...current,
                      [key]: {
                        ...(current[key] ?? emptyReportRow),
                        count: event.target.value,
                      },
                    }))
                  }
                />
              </DataGridCellAction>
            );
          },
        }),
      ]),
    [rows],
  );
  const reportData = React.useMemo(() => shelf, [shelf]);
  const reportTable = useTable({
    features: gridFeatures,
    columns: reportColumns,
    data: reportData,
    getRowId: (row) => skuKey(row),
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Record {location.name}&apos;s report</DialogTitle>
          <DialogDescription>
            What sold, what is coming back, and the cheque — together. Revenue is
            recognised now; anything they have not paid stays a balance due on
            the order. Their shelf count is optional: where it disagrees with
            ours, the difference is recorded as shrink at their location.
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
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>
                {overCount ??
                  (overpaid
                    ? `The payment is more than the ${formatMoney(owed)} this report owes.`
                    : error)}
              </span>
            </div>
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

          <DataGrid
            table={reportTable}
            aria-label={`${location.name} report lines`}
            listenOnWindow={false}
          />

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
          cell: ({ row: { original: row } }) => (
            <Dimmed dim={movementDim(row)}>
              {row.label}
              {row.lotCode && (
                <span className="ml-2 text-xs text-muted-foreground">
                  lot {row.lotCode}
                </span>
              )}
            </Dimmed>
          ),
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
