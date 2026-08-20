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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
    <div className="mx-auto grid w-full max-w-5xl gap-5">
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
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">On shelf</TableHead>
                    <TableHead className="text-right">Shelf price</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.shelf.map((row) => (
                    <TableRow key={skuKey(row)}>
                      <TableCell className="font-medium">{row.label}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {row.onHand}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.unitPrice != null ? formatMoney(row.unitPrice) : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {data.unsettled.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Reported sold, not yet paid</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead className="text-right">Invoiced</TableHead>
                  <TableHead className="text-right">Collected</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.unsettled.map((sale) => (
                  <TableRow key={sale.id}>
                    <TableCell>{formatDate(sale.date)}</TableCell>
                    <TableCell>
                      <Link
                        className="underline underline-offset-2"
                        href={`/sales/${sale.id}`}
                      >
                        {sale.orderNumber ?? "View"}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(sale.totalAmount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(sale.amountPaid)}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                      {formatMoney(sale.balanceDue)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Shelf</TableHead>
                  <TableHead className="w-20">Sold</TableHead>
                  <TableHead className="w-20">Back</TableHead>
                  <TableHead className="w-24">Price</TableHead>
                  <TableHead className="w-24">Their count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shelf.map((row) => {
                  const key = skuKey(row);
                  const entry = rows[key] ?? emptyReportRow;
                  const update = (field: keyof ReportRow, value: string) =>
                    setRows((current) => ({
                      ...current,
                      [key]: { ...(current[key] ?? emptyReportRow), [field]: value },
                    }));
                  return (
                    <TableRow key={key}>
                      <TableCell className="font-medium">{row.label}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.onHand}
                      </TableCell>
                      <TableCell>
                        <Input
                          aria-label={`${row.label} sold`}
                          type="number"
                          min="0"
                          max={row.onHand}
                          value={entry.sold}
                          placeholder="0"
                          onChange={(event) => update("sold", event.target.value)}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          aria-label={`${row.label} returned`}
                          type="number"
                          min="0"
                          max={row.onHand}
                          value={entry.returned}
                          placeholder="0"
                          onChange={(event) => update("returned", event.target.value)}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          aria-label={`${row.label} shelf price`}
                          type="number"
                          min="0"
                          step="0.01"
                          value={entry.price}
                          placeholder={
                            row.unitPrice != null ? String(row.unitPrice) : "0.00"
                          }
                          onChange={(event) => update("price", event.target.value)}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          aria-label={`${row.label} counted on shelf`}
                          type="number"
                          min="0"
                          value={entry.count}
                          placeholder="—"
                          onChange={(event) => update("count", event.target.value)}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
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

function SettlementHistory({
  settlements,
}: {
  settlements: StockLocationDetail["settlements"];
}) {
  const voidSettlement = useVoidStockSettlement();
  if (settlements.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Reports</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Owed</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Their cut</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {settlements.map((row) => (
              <TableRow key={row.id} className={row.voidedAt ? "opacity-60" : undefined}>
                <TableCell>
                  {formatDate(row.periodStart)} – {formatDate(row.periodEnd)}
                  {row.voidedAt && (
                    <Badge variant="outline" className="ml-2">
                      voided
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(row.amountOwed)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(row.amountPaid)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(row.commission)}
                </TableCell>
                <TableCell className="text-right">
                  {!row.voidedAt && (
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
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function MovementHistory({
  movements,
}: {
  movements: StockLocationDetail["movements"];
}) {
  const reverse = useReverseStockMovement();
  if (movements.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Movements</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {movements.map((row) => (
              <TableRow
                key={row.id}
                className={
                  row.isReversal || row.reversedByMovementId ? "opacity-60" : undefined
                }
              >
                <TableCell>{formatDate(row.date)}</TableCell>
                <TableCell className="capitalize">
                  {row.kind}
                  {row.isReversal && " (reversal)"}
                  {row.counterpartyName && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {row.quantity > 0 ? "from" : "to"} {row.counterpartyName}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {row.label}
                  {row.lotCode && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      lot {row.lotCode}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.quantity > 0 ? `+${row.quantity}` : row.quantity}
                </TableCell>
                <TableCell className="text-right">
                  {!row.isReversal && !row.reversedByMovementId && !row.settlementId && (
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
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
