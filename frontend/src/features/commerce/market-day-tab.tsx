"use client";

import * as React from "react";
import { Minus, Plus, ShoppingBasket, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShortcutForm } from "@/components/ui/shortcut-form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney, todayISO } from "@/features/honey/format";
import { useJarInventory, useRecordSale } from "@/features/honey/hooks";
import { OfflineQueuedError } from "@/lib/api";
import { useHarvestLots, useLowStock, useReconciliation } from "./api";

export function MarketDayTab({
  onCartCountChange,
}: {
  /**
   * Reports how many jars are in the cart so the surrounding full-screen
   * route can confirm before an exit throws a sale away.
   */
  onCartCountChange?: (count: number) => void;
} = {}) {
  const inventory = useJarInventory();
  const sale = useRecordSale();
  const lowStock = useLowStock();
  const lots = useHarvestLots();
  const [date, setDate] = React.useState(todayISO());
  const reconciliation = useReconciliation(date);
  const [cart, setCart] = React.useState<Record<string, number>>({});
  const [channel, setChannel] = React.useState<"farmers_market" | "farm_stand" | "pickup" | "direct">("farmers_market");
  const [payment, setPayment] = React.useState<"cash" | "card" | "venmo" | "check" | "other">("cash");
  const [discount, setDiscount] = React.useState("0");
  const [customer, setCustomer] = React.useState("");
  const [harvestLotId, setHarvestLotId] = React.useState("none");

  const cartCount = Object.values(cart).reduce((sum, qty) => sum + qty, 0);
  React.useEffect(() => {
    onCartCountChange?.(cartCount);
  }, [cartCount, onCartCountChange]);

  if (inventory.isPending) return <Skeleton className="h-72" />;
  if (inventory.isError) return <p className="py-8 text-center text-sm text-muted-foreground">Could not load market inventory.</p>;

  const lines = inventory.data
    .map((row) => ({
      jarSizeId: row.jarSizeId,
      quantity: cart[row.jarSizeId] ?? 0,
      unitPrice: row.defaultPrice ?? 0,
    }))
    .filter((line) => line.quantity > 0);
  const unpriced = lines.filter((line) => line.unitPrice <= 0);
  const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  const discountAmount = Math.min(subtotal, Math.max(0, Number(discount) || 0));
  const total = subtotal - discountAmount;

  function adjust(id: string, delta: number, onHand: number) {
    setCart((current) => ({
      ...current,
      [id]: Math.max(0, Math.min(onHand, (current[id] ?? 0) + delta)),
    }));
  }

  function checkout() {
    if (lines.length === 0 || unpriced.length > 0) return;
    sale.mutate({
      date,
      channel,
      paymentMethod: payment,
      harvestLotId: harvestLotId === "none" ? undefined : harvestLotId,
      customerName: customer.trim() || undefined,
      discountAmount,
      amountPaid: total,
      orderStatus: "paid",
      location: channel === "farmers_market" ? "Farmers market" : undefined,
      lines,
    }, {
      onSuccess: () => {
        setCart({});
        setDiscount("0");
        setCustomer("");
        toast.success("Sale complete; inventory updated");
      },
      onError: (error) => {
        if (error instanceof OfflineQueuedError) {
          // Accepted into the offline queue — do not claim inventory updated.
          // Clearing avoids a second tap queueing a duplicate sale.
          setCart({});
          setDiscount("0");
          setCustomer("");
          return;
        }
        toast.error(error instanceof Error ? error.message : "Sale failed");
      },
    });
  }

  const saleQueued = sale.error instanceof OfflineQueuedError;
  const saleError =
    saleQueued
      ? null
      : sale.error instanceof Error
        ? sale.error.message
        : null;

  return (
    <div className="grid gap-5">
      {(lowStock.data?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <TriangleAlert className="size-4 text-amber-600" />
          <span className="font-medium">Low stock:</span>
          {lowStock.data?.map((row) => <Badge key={row.jarSizeId} variant="outline">{row.label} {row.onHand}/{row.threshold}</Badge>)}
        </div>
      )}
      <div className="grid items-start gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {inventory.data.map((row) => {
            const quantity = cart[row.jarSizeId] ?? 0;
            return (
              <Card key={row.jarSizeId} className={quantity > 0 ? "border-primary" : ""}>
                <CardContent className="grid gap-3 p-4">
                  <button type="button" className="grid min-h-20 place-items-center rounded-md bg-amber-500/10 p-3 text-center hover:bg-amber-500/20" onClick={() => adjust(row.jarSizeId, 1, row.onHand)} disabled={row.onHand <= quantity}>
                    <span><span className="block text-lg font-bold">{row.label}</span><span className="text-sm text-muted-foreground">{row.defaultPrice && row.defaultPrice > 0 ? formatMoney(row.defaultPrice) : "No price"} · {row.onHand} left</span></span>
                  </button>
                  <div className="flex items-center justify-between">
                    <Button size="icon-sm" variant="outline" onClick={() => adjust(row.jarSizeId, -1, row.onHand)} disabled={quantity === 0}><Minus /></Button>
                    <span className="text-xl font-bold tabular-nums">{quantity}</span>
                    <Button size="icon-sm" variant="outline" onClick={() => adjust(row.jarSizeId, 1, row.onHand)} disabled={quantity >= row.onHand}><Plus /></Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
        <Card className="lg:sticky lg:top-6">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShoppingBasket className="size-4" /> Current sale</CardTitle></CardHeader>
          <CardContent>
            <ShortcutForm
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                checkout();
              }}
              onSubmitAndReset={checkout}
            >
            {unpriced.length > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>
                  Set a default price on{" "}
                  {unpriced
                    .map((line) =>
                      inventory.data.find((row) => row.jarSizeId === line.jarSizeId)
                        ?.label,
                    )
                    .filter(Boolean)
                    .join(", ")}{" "}
                  in Settings before recording a paid sale.
                </span>
              </div>
            )}
            {saleError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{saleError}</span>
              </div>
            )}
            {saleQueued && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <span>Sale accepted offline — will sync when you reconnect. Inventory is not updated yet.</span>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1"><Label>Date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
              <div className="grid gap-1"><Label>Channel</Label><Select value={channel} onValueChange={(value) => setChannel(value as typeof channel)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="farmers_market">Farmers market</SelectItem><SelectItem value="farm_stand">Farm stand</SelectItem><SelectItem value="pickup">Pickup</SelectItem><SelectItem value="direct">Direct</SelectItem></SelectContent></Select></div>
            </div>
            <div className="grid gap-1"><Label>Payment</Label><Select value={payment} onValueChange={(value) => setPayment(value as typeof payment)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="cash">Cash</SelectItem><SelectItem value="card">Card</SelectItem><SelectItem value="venmo">Venmo</SelectItem><SelectItem value="check">Check</SelectItem><SelectItem value="other">Other</SelectItem></SelectContent></Select></div>
            <div className="grid gap-1">
              <Label>Harvest lot</Label>
              <Select value={harvestLotId} onValueChange={setHarvestLotId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unassigned</SelectItem>
                  {(lots.data ?? []).map((lot) => (
                    <SelectItem key={lot.id} value={lot.id}>{lot.lotCode}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3"><div className="grid gap-1"><Label>Discount</Label><Input type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} /></div><div className="grid gap-1"><Label>Customer</Label><Input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Optional" /></div></div>
            <div className="grid gap-1 border-y py-3 text-sm">
              {lines.map((line) => {
                const row = inventory.data.find((item) => item.jarSizeId === line.jarSizeId);
                return <div key={line.jarSizeId} className="flex justify-between"><span>{line.quantity} × {row?.label}</span><span>{formatMoney(line.quantity * line.unitPrice)}</span></div>;
              })}
              {discountAmount > 0 && <div className="flex justify-between text-muted-foreground"><span>Discount</span><span>−{formatMoney(discountAmount)}</span></div>}
            </div>
            <div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">Total</span><span className="text-3xl font-bold tabular-nums">{formatMoney(total)}</span></div>
            <Button type="submit" size="lg" className="h-14 text-base" disabled={sale.isPending || lines.length === 0 || unpriced.length > 0}>{sale.isPending ? "Completing…" : "Complete sale"}</Button>
            </ShortcutForm>
          </CardContent>
        </Card>
      </div>
      <ReconciliationCard date={date} loading={reconciliation.isPending} data={reconciliation.data} />
    </div>
  );
}

function ReconciliationCard({ date, loading, data }: { date: string; loading: boolean; data: ReturnType<typeof useReconciliation>["data"] }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">End-of-day reconciliation · {date}</CardTitle></CardHeader>
      <CardContent>
        {loading ? <Skeleton className="h-24" /> : data ? (
          <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Summary label="Orders" value={String(data.orderCount)} /><Summary label="Gross sales (invoiced)" value={formatMoney(data.grossSales)} /><Summary label="Collected" value={formatMoney(data.amountCollected)} /><Summary label="Balance due" value={formatMoney(data.balanceDue)} /></div>
            <Table><TableHeader><TableRow><TableHead>Payment</TableHead><TableHead>Channel</TableHead><TableHead className="text-right">Orders</TableHead><TableHead className="text-right">Collected</TableHead></TableRow></TableHeader><TableBody>{data.breakdown.map((row) => <TableRow key={`${row.paymentMethod}-${row.channel}`}><TableCell className="capitalize">{row.paymentMethod}</TableCell><TableCell className="capitalize">{row.channel.replaceAll("_", " ")}</TableCell><TableCell className="text-right">{row.orderCount}</TableCell><TableCell className="text-right">{formatMoney(row.paid)}</TableCell></TableRow>)}</TableBody></Table>
          </div>
        ) : <p className="text-sm text-muted-foreground">Reconciliation unavailable.</p>}
      </CardContent>
    </Card>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md bg-muted p-3"><p className="text-xs uppercase text-muted-foreground">{label}</p><p className="text-lg font-bold">{value}</p></div>;
}
