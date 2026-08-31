"use client";

import * as React from "react";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
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
  DataGrid,
  type DataGridColumnMeta,
} from "@/components/ui/data-grid";
import { formatMoney, todayISO } from "@/features/honey/format";
import { useJarInventory, useProductCatalog, useRecordSale } from "@/features/honey/hooks";
import type { CatalogProduct, SaleLineKind } from "@/features/honey/types";
import { OfflineQueuedError } from "@/lib/api";
import {
  useHarvestLots,
  useLowStock,
  useReconciliation,
  type Reconciliation,
} from "./api";
import {
  useStockInventory,
  useStockLocationSale,
} from "./stock-locations-api";

function jarKey(id: string) {
  return `jar:${id}`;
}
function productKey(id: string) {
  return `product:${id}`;
}

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
  const catalog = useProductCatalog(true);
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
  // Market day sells from ONE place at a time. Home is the default and
  // usually the only choice; an empty id means "home, and we have not
  // heard back from the locations request yet".
  const [locationId, setLocationId] = React.useState("");
  const stock = useStockInventory();
  const locationSale = useStockLocationSale(locationId);

  const cartCount = Object.values(cart).reduce((sum, qty) => sum + qty, 0);
  React.useEffect(() => {
    onCartCountChange?.(cartCount);
  }, [cartCount, onCartCountChange]);

  if (inventory.isPending) return <Skeleton className="h-72" />;
  if (inventory.isError) return <p className="py-8 text-center text-sm text-muted-foreground">Could not load market inventory.</p>;

  const products = catalog.data?.items ?? [];
  const propolisGrams = catalog.data?.propolisOnHandGrams ?? 0;

  const locations = stock.data?.locations ?? [];
  const homeId = locations.find((location) => location.isHome)?.id ?? "";
  const sellingFrom = locationId || homeId;
  const sellingHome = sellingFrom === "" || sellingFrom === homeId;
  // What is actually on the shelf at the chosen place. Until the request
  // lands there is nothing to subtract, so the global figure stands in.
  const onShelf = new Map<string, number>();
  // Guard the shape, not just presence: a malformed payload must fall back
  // to the global figure rather than reading every shelf as empty.
  const stockItems = Array.isArray(stock.data?.items) ? stock.data.items : null;
  for (const item of stockItems ?? []) {
    const key = item.jarSizeId
      ? jarKey(item.jarSizeId)
      : productKey(item.productId ?? "");
    onShelf.set(key, item.byLocation[sellingFrom] ?? 0);
  }
  const stockFor = (key: string, fallback: number) =>
    stockItems ? (onShelf.get(key) ?? 0) : fallback;
  const awayUnits = locations
    .filter((location) => !location.isHome)
    .reduce((sum, location) => sum + location.onHandUnits, 0);
  const jarRows = inventory.data.map((row) => ({
    ...row,
    onHand: stockFor(jarKey(row.jarSizeId), row.onHand),
  }));
  const jarLines = jarRows
    .map((row) => ({
      kind: "jar" as const,
      jarSizeId: row.jarSizeId,
      label: row.label,
      quantity: cart[jarKey(row.jarSizeId)] ?? 0,
      unitPrice: row.defaultPrice ?? 0,
    }))
    .filter((line) => line.quantity > 0);
  const productLines = products
    .map((row) => ({
      kind: row.kind as SaleLineKind,
      productId: row.id,
      label: row.sizeLabel ? `${row.name} · ${row.sizeLabel}` : row.name,
      quantity: cart[productKey(row.id)] ?? 0,
      unitPrice: row.defaultPrice ?? 0,
    }))
    .filter((line) => line.quantity > 0);
  const lines = [...jarLines, ...productLines];
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

  function clearCart() {
    setCart({});
    setDiscount("0");
    setCustomer("");
  }

  function checkout() {
    if (lines.length === 0 || unpriced.length > 0) return;
    if (!sellingHome) {
      // Stock came off another shelf, so the sale has to say so or home
      // would be the one debited. No offline queue on this path: the
      // queue only knows the home sale route.
      locationSale.mutate(
        {
          date,
          channel,
          paymentMethod: payment,
          customerName: customer.trim() || undefined,
          discountAmount,
          amountPaid: total,
          lines: lines.map((line) =>
            "jarSizeId" in line && line.jarSizeId
              ? { jarSizeId: line.jarSizeId, quantity: line.quantity, unitPrice: line.unitPrice }
              : { productId: "productId" in line ? line.productId : "", quantity: line.quantity, unitPrice: line.unitPrice },
          ),
        },
        {
          onSuccess: () => {
            clearCart();
            toast.success("Sale complete; inventory updated");
          },
          onError: (error) =>
            toast.error(error instanceof Error ? error.message : "Sale failed"),
        },
      );
      return;
    }
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
      lines: lines.map((line) =>
        "jarSizeId" in line && line.jarSizeId
          ? { kind: "jar" as const, jarSizeId: line.jarSizeId, quantity: line.quantity, unitPrice: line.unitPrice }
          : { kind: line.kind, productId: "productId" in line ? line.productId : "", quantity: line.quantity, unitPrice: line.unitPrice },
      ),
    }, {
      onSuccess: () => {
        clearCart();
        toast.success("Sale complete; inventory updated");
      },
      onError: (error) => {
        if (error instanceof OfflineQueuedError) {
          // Accepted into the offline queue — do not claim inventory updated.
          // Clearing avoids a second tap queueing a duplicate sale.
          clearCart();
          return;
        }
        toast.error(error instanceof Error ? error.message : "Sale failed");
      },
    });
  }

  const saleQueued = sale.error instanceof OfflineQueuedError;
  const activeError = sellingHome ? sale.error : locationSale.error;
  const saleError =
    saleQueued
      ? null
      : activeError instanceof Error
        ? activeError.message
        : null;
  const salePending = sellingHome ? sale.isPending : locationSale.isPending;

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
          {jarRows.map((row) => {
            const key = jarKey(row.jarSizeId);
            const quantity = cart[key] ?? 0;
            return (
              <Card key={key} className={quantity > 0 ? "border-primary" : ""}>
                <CardContent className="grid gap-3 p-4">
                  <button type="button" className="grid min-h-20 place-items-center rounded-md bg-amber-500/10 p-3 text-center hover:bg-amber-500/20" onClick={() => adjust(key, 1, row.onHand)} disabled={row.onHand <= quantity}>
                    <span><span className="block text-lg font-bold">{row.label}</span><span className="text-sm text-muted-foreground">{row.defaultPrice && row.defaultPrice > 0 ? formatMoney(row.defaultPrice) : "No price"} · {row.onHand} left</span></span>
                  </button>
                  <div className="flex items-center justify-between">
                    <Button size="icon-sm" variant="outline" onClick={() => adjust(key, -1, row.onHand)} disabled={quantity === 0}><Minus /></Button>
                    <span className="text-xl font-bold tabular-nums">{quantity}</span>
                    <Button size="icon-sm" variant="outline" onClick={() => adjust(key, 1, row.onHand)} disabled={quantity >= row.onHand}><Plus /></Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
          {products.map((row) => (
            <ProductButton
              key={productKey(row.id)}
              product={row}
              propolisGrams={propolisGrams}
              quantity={cart[productKey(row.id)] ?? 0}
              onAdjust={adjust}
            />
          ))}
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
                  {unpriced.map((line) => line.label).filter(Boolean).join(", ")}{" "}
                  in Settings or Products before recording a paid sale.
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
            {(locations.length > 1 || awayUnits > 0) && (
              <div className="grid gap-1">
                <Label>Selling from</Label>
                <Select
                  value={sellingFrom}
                  onValueChange={(value) => {
                    // The cart was priced against the old shelf; keeping it
                    // would let a count that fitted at home overdraw a shop.
                    setCart({});
                    setLocationId(value);
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {locations.map((location) => (
                      <SelectItem
                        key={location.id}
                        value={location.id}
                        disabled={location.isConsignment}
                      >
                        {location.name}
                        {location.isConsignment ? " · settles by report" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {awayUnits > 0 && sellingHome && (
                  <p className="text-xs text-muted-foreground">
                    {awayUnits} units are at another location and are not on
                    this table.
                  </p>
                )}
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
                    <SelectItem key={lot.id} value={lot.id} disabled={lot.lockout?.locked}>
                      {lot.lotCode}{lot.lockout?.locked ? " · locked" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(() => {
                const selected = (lots.data ?? []).find((lot) => lot.id === harvestLotId);
                if (!selected?.lockout?.locked) return null;
                return (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {selected.lockout.message}
                  </p>
                );
              })()}
            </div>
            <div className="grid grid-cols-2 gap-3"><div className="grid gap-1"><Label>Discount</Label><Input type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} /></div><div className="grid gap-1"><Label>Customer</Label><Input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Optional" /></div></div>
            <div className="grid gap-1 border-y py-3 text-sm">
              {lines.map((line) => {
                const key = "jarSizeId" in line && line.jarSizeId
                  ? jarKey(line.jarSizeId)
                  : productKey("productId" in line ? line.productId : "");
                return <div key={key} className="flex justify-between"><span>{line.quantity} × {line.label}</span><span>{formatMoney(line.quantity * line.unitPrice)}</span></div>;
              })}
              {discountAmount > 0 && <div className="flex justify-between text-muted-foreground"><span>Discount</span><span>−{formatMoney(discountAmount)}</span></div>}
            </div>
            <div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">Total</span><span className="text-3xl font-bold tabular-nums">{formatMoney(total)}</span></div>
            <Button type="submit" size="lg" className="h-14 text-base" disabled={salePending || lines.length === 0 || unpriced.length > 0}>{salePending ? "Completing…" : "Complete sale"}</Button>
            </ShortcutForm>
          </CardContent>
        </Card>
      </div>
      <ReconciliationCard date={date} loading={reconciliation.isPending} data={reconciliation.data} />
    </div>
  );
}

function ProductButton({
  product,
  propolisGrams,
  quantity,
  onAdjust,
}: {
  product: CatalogProduct;
  propolisGrams: number;
  quantity: number;
  onAdjust: (id: string, delta: number, onHand: number) => void;
}) {
  const key = productKey(product.id);
  // Raw propolis sells off the harvest ledger: units that fit in grams on hand.
  const propolisUnits =
    product.kind === "propolis" && product.netGrams && product.netGrams > 0
      ? Math.max(0, Math.floor((propolisGrams + 1e-9) / product.netGrams))
      : null;
  const cap = propolisUnits !== null ? propolisUnits : product.onHand > 0 ? product.onHand : 99;
  const stockText =
    propolisUnits !== null
      ? `${propolisUnits} left (${propolisGrams.toFixed(1)} g)`
      : product.onHand > 0
        ? `${product.onHand} left`
        : product.kind.replaceAll("_", " ");
  const label = product.sizeLabel ? `${product.name} · ${product.sizeLabel}` : product.name;
  return (
    <Card className={quantity > 0 ? "border-primary" : ""}>
      <CardContent className="grid gap-3 p-4">
        <button
          type="button"
          className="grid min-h-20 place-items-center rounded-md bg-primary/10 p-3 text-center hover:bg-primary/15"
          onClick={() => onAdjust(key, 1, cap)}
          disabled={quantity >= cap}
        >
          <span>
            <span className="block text-lg font-bold">{label}</span>
            <span className="text-sm text-muted-foreground">
              {product.defaultPrice > 0 ? formatMoney(product.defaultPrice) : "No price"}
              {" · "}
              {stockText}
            </span>
          </span>
        </button>
        <div className="flex items-center justify-between">
          <Button size="icon-sm" variant="outline" onClick={() => onAdjust(key, -1, cap)} disabled={quantity === 0}><Minus /></Button>
          <span className="text-xl font-bold tabular-nums">{quantity}</span>
          <Button size="icon-sm" variant="outline" onClick={() => onAdjust(key, 1, cap)} disabled={quantity >= cap}><Plus /></Button>
        </div>
      </CardContent>
    </Card>
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
            <BreakdownTable rows={data.breakdown} />
          </div>
        ) : <p className="text-sm text-muted-foreground">Reconciliation unavailable.</p>}
      </CardContent>
    </Card>
  );
}

type BreakdownRow = Reconciliation["breakdown"][number];

const gridFeatures = tableFeatures({});

const rightAligned: DataGridColumnMeta = {
  align: "right",
  cellClassName: "tabular-nums",
};

const breakdownHelper = createColumnHelper<typeof gridFeatures, BreakdownRow>();
const breakdownColumns = breakdownHelper.columns([
  breakdownHelper.display({
    id: "payment",
    header: "Payment",
    meta: { cellClassName: "capitalize" } satisfies DataGridColumnMeta,
    cell: ({ row }) => row.original.paymentMethod,
  }),
  breakdownHelper.display({
    id: "channel",
    header: "Channel",
    meta: { cellClassName: "capitalize" } satisfies DataGridColumnMeta,
    cell: ({ row }) => row.original.channel.replaceAll("_", " "),
  }),
  breakdownHelper.display({
    id: "orders",
    header: "Orders",
    meta: rightAligned,
    cell: ({ row }) => row.original.orderCount,
  }),
  breakdownHelper.display({
    id: "collected",
    header: "Collected",
    meta: rightAligned,
    cell: ({ row }) => formatMoney(row.original.paid),
  }),
]);

function BreakdownTable({ rows }: { rows: BreakdownRow[] }) {
  const data = React.useMemo(() => rows, [rows]);
  const table = useTable({
    features: gridFeatures,
    columns: breakdownColumns,
    data,
    getRowId: (row) => `${row.paymentMethod}-${row.channel}`,
  });
  // The market-day screen is a keyboard-heavy point of sale; this summary
  // table must not grab window keystrokes.
  return (
    <DataGrid
      table={table}
      aria-label="Reconciliation breakdown"
      listenOnWindow={false}
    />
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md bg-muted p-3"><p className="text-xs uppercase text-muted-foreground">{label}</p><p className="text-lg font-bold">{value}</p></div>;
}
