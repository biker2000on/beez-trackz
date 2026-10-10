"use client";

/**
 * Market day: the stall's point of sale.
 *
 * The screen lists what can actually be sold, one row per varietal × size ×
 * lot with stock at the shelf being sold from: "Sourwood · Quart ·
 * 2026-SOURWOOD · 36 left · $30". Nothing at zero is ever shown — not a size,
 * not a lot. Two lots of the same varietal and size are two rows, told apart
 * by lot code. Catalog products with stock are rows of their own. Every row
 * posts its harvest lot, so every jar sold here is traceable.
 *
 * Rows are phone-first: the name is a big tap target that adds one, − and +
 * sit beside a typed count, and the price (prefilled from the size's default)
 * is editable in place. The running total and Complete sale stay pinned to
 * the bottom of the screen.
 */

import * as React from "react";
import Link from "next/link";
import {
  createColumnHelper,
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
  dataGridFeatures,
} from "@/components/ui/data-grid";
import { formatMoney, todayISO } from "@/features/honey/format";
import { useJarInventory, useProductCatalog, useRecordSale } from "@/features/honey/hooks";
import type { SaleLineKind } from "@/features/honey/types";
import { OfflineQueuedError } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  useLowStock,
  useReconciliation,
  type Reconciliation,
} from "./api";
import { compareNullable, shelfSkus } from "./lot-lines";
import {
  useStockInventory,
  useStockLocationSale,
} from "./stock-locations-api";

/** One sellable row: a jar size from one lot, or a catalog product. */
interface MarketRow {
  key: string;
  /** The heading: "Sourwood · Quart", or the product name. */
  title: string;
  /** "2026-SOURWOOD-01 · 36 left". */
  detail: string;
  /** The group the row is listed under: its varietal, or "Other products". */
  group: string;
  left: number;
  defaultPrice: number;
  jarSizeId?: string;
  harvestLotId?: string;
  productId?: string;
  productKind?: SaleLineKind;
}

const OTHER = "Other products";
const NO_VARIETAL = "Unnamed varietal";

function priceText(value: number): string {
  return value > 0 ? String(value) : "";
}

export function MarketDayTab({
  onCartCountChange,
}: {
  /**
   * Reports how many units are in the cart so the surrounding full-screen
   * route can confirm before an exit throws a sale away.
   */
  onCartCountChange?: (count: number) => void;
} = {}) {
  const inventory = useJarInventory();
  const catalog = useProductCatalog(true);
  const sale = useRecordSale();
  const lowStock = useLowStock();
  const [date, setDate] = React.useState(todayISO());
  const reconciliation = useReconciliation(date);
  const [cart, setCart] = React.useState<Record<string, number>>({});
  const [prices, setPrices] = React.useState<Record<string, string>>({});
  const [channel, setChannel] = React.useState<"farmers_market" | "farm_stand" | "pickup" | "direct">("farmers_market");
  const [payment, setPayment] = React.useState<"cash" | "card" | "venmo" | "check" | "other">("cash");
  const [discount, setDiscount] = React.useState("0");
  const [customer, setCustomer] = React.useState("");
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

  if (inventory.isPending || stock.isPending) return <Skeleton className="h-72" />;
  if (inventory.isError) return <p className="py-8 text-center text-sm text-muted-foreground">Could not load market inventory.</p>;

  const products = catalog.data?.items ?? [];
  const propolisGrams = catalog.data?.propolisOnHandGrams ?? 0;
  const locations = stock.data?.locations ?? [];
  const homeId = locations.find((location) => location.isHome)?.id ?? "";
  const sellingFrom = locationId || homeId;
  const sellingHome = sellingFrom === "" || sellingFrom === homeId;
  const skus = shelfSkus(stock.data?.items, sellingFrom);
  const sizeOrder = new Map(inventory.data.map((row, index) => [row.jarSizeId, index]));
  const sizeDefault = new Map(inventory.data.map((row) => [row.jarSizeId, row.defaultPrice ?? 0]));

  // --- the rows: varietal × size × lot, then products, nothing at zero ---
  const rows: MarketRow[] = [];
  for (const sku of skus) {
    if (sku.jarSizeId) {
      for (const lot of sku.lots) {
        rows.push({
          key: `jar:${sku.jarSizeId}|${lot.harvestLotId}`,
          title: `${lot.varietalName ?? NO_VARIETAL} · ${sku.label}`,
          detail: `${lot.lotCode ?? "Lot"} · ${lot.at} left`,
          group: lot.varietalName ?? NO_VARIETAL,
          left: lot.at,
          defaultPrice: sizeDefault.get(sku.jarSizeId) || sku.unitPrice || 0,
          jarSizeId: sku.jarSizeId,
          harvestLotId: lot.harvestLotId,
        });
      }
      continue;
    }
    const product = products.find((item) => item.id === sku.productId);
    if (!product || product.kind === "propolis") continue;
    rows.push({
      key: `product:${product.id}`,
      title: product.sizeLabel ? `${product.name} · ${product.sizeLabel}` : product.name,
      detail: `${sku.at} left`,
      group: OTHER,
      left: sku.at,
      defaultPrice: product.defaultPrice || sku.unitPrice || 0,
      productId: product.id,
      productKind: product.kind as SaleLineKind,
    });
  }
  // Raw propolis sells off the harvest ledger by the gram, at home only.
  if (sellingHome) {
    for (const product of products) {
      if (product.kind !== "propolis" || !product.netGrams || product.netGrams <= 0) continue;
      const units = Math.max(0, Math.floor((propolisGrams + 1e-9) / product.netGrams));
      if (units <= 0) continue;
      rows.push({
        key: `product:${product.id}`,
        title: product.sizeLabel ? `${product.name} · ${product.sizeLabel}` : product.name,
        detail: `${units} left (${propolisGrams.toFixed(1)} g)`,
        group: OTHER,
        left: units,
        defaultPrice: product.defaultPrice,
        productId: product.id,
        productKind: "propolis",
      });
    }
  }
  rows.sort((a, b) => {
    const groupA = a.group === OTHER ? null : a.group === NO_VARIETAL ? "￿" : a.group;
    const groupB = b.group === OTHER ? null : b.group === NO_VARIETAL ? "￿" : b.group;
    return (
      compareNullable(groupA, groupB) ||
      (sizeOrder.get(a.jarSizeId ?? "") ?? 999) - (sizeOrder.get(b.jarSizeId ?? "") ?? 999) ||
      a.detail.localeCompare(b.detail) ||
      a.title.localeCompare(b.title)
    );
  });
  const groups: { name: string; rows: MarketRow[] }[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.name === row.group) last.rows.push(row);
    else groups.push({ name: row.group, rows: [row] });
  }
  const rowByKey = new Map(rows.map((row) => [row.key, row]));

  const priceOf = (row: MarketRow) => {
    const text = prices[row.key];
    if (text == null) return row.defaultPrice;
    const value = Number(text);
    return Number.isFinite(value) ? value : 0;
  };
  // A row whose stock vanished (another device sold it) drops out of the
  // sale rather than posting a line the server will refuse.
  const lines = Object.entries(cart)
    .map(([key, quantity]) => ({ row: rowByKey.get(key), quantity }))
    .filter((entry): entry is { row: MarketRow; quantity: number } => entry.row != null && entry.quantity > 0)
    .map(({ row, quantity }) => ({
      row,
      quantity: Math.min(quantity, row.left),
      unitPrice: priceOf(row),
    }));
  const unpriced = lines.filter((line) => line.unitPrice <= 0);
  const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  const discountAmount = Math.min(subtotal, Math.max(0, Number(discount) || 0));
  const total = subtotal - discountAmount;
  const units = lines.reduce((sum, line) => sum + line.quantity, 0);
  const awayUnits = locations
    .filter((location) => !location.isHome)
    .reduce((sum, location) => sum + location.onHandUnits, 0);
  const unattributed = skus.filter((sku) => sku.lotTracked && sku.unattributed > 0);

  function setQuantity(key: string, quantity: number, left: number) {
    setCart((current) => ({
      ...current,
      [key]: Math.max(0, Math.min(left, Math.trunc(quantity) || 0)),
    }));
  }

  function clearCart() {
    setCart({});
    setPrices({});
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
          lines: lines.map(({ row, quantity, unitPrice }) =>
            row.jarSizeId
              ? { jarSizeId: row.jarSizeId, harvestLotId: row.harvestLotId, quantity, unitPrice }
              : { productId: row.productId ?? "", quantity, unitPrice },
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
      customerName: customer.trim() || undefined,
      discountAmount,
      amountPaid: total,
      orderStatus: "paid",
      location: channel === "farmers_market" ? "Farmers market" : undefined,
      lines: lines.map(({ row, quantity, unitPrice }) =>
        row.jarSizeId
          ? { kind: "jar" as const, jarSizeId: row.jarSizeId, harvestLotId: row.harvestLotId, quantity, unitPrice }
          : { kind: row.productKind ?? ("product" as SaleLineKind), productId: row.productId ?? "", quantity, unitPrice },
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
    <ShortcutForm
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        checkout();
      }}
      onSubmitAndReset={checkout}
    >
      {(lowStock.data?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <TriangleAlert className="size-4 text-amber-600" />
          <span className="font-medium">Low stock:</span>
          {lowStock.data?.map((row) => <Badge key={row.jarSizeId} variant="outline">{row.label} {row.onHand}/{row.threshold}</Badge>)}
        </div>
      )}
      <div className="grid items-start gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="grid min-w-0 gap-5" aria-label="Products for sale">
          {groups.length === 0 && (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              Nothing with stock {sellingHome ? "at home" : "at this location"} to sell.
            </p>
          )}
          {groups.map((group) => (
            <section key={group.name} className="grid gap-2" aria-label={group.name}>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {group.name}
              </h2>
              <ul className="grid gap-2 md:grid-cols-2">
                {group.rows.map((row) => (
                  <MarketRowItem
                    key={row.key}
                    row={row}
                    quantity={Math.min(cart[row.key] ?? 0, row.left)}
                    price={prices[row.key] ?? priceText(row.defaultPrice)}
                    onQuantity={(quantity) => setQuantity(row.key, quantity, row.left)}
                    onPrice={(text) => setPrices((current) => ({ ...current, [row.key]: text }))}
                  />
                ))}
              </ul>
            </section>
          ))}
          {unattributed.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {unattributed.map((sku) => `${sku.unattributed} ${sku.label}`).join(", ")} carry no
              lot and are not listed: every jar sold here names its varietal.
            </p>
          )}
        </div>
        <Card className="lg:sticky lg:top-20">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShoppingBasket className="size-4" /> Current sale</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            {unpriced.length > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>
                  Set a price on {unpriced.map((line) => line.row.title).join(", ")} before
                  recording a paid sale, or set default prices in{" "}
                  <Link
                    href="/admin/setup#jar-sizes"
                    className="font-medium underline underline-offset-4"
                  >
                    Operation setup
                  </Link>
                  .
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
                <Label htmlFor="market-from">Selling from</Label>
                <Select
                  value={sellingFrom}
                  onValueChange={(value) => {
                    // The cart was counted against the old shelf; keeping it
                    // would let a count that fitted at home overdraw a shop.
                    setCart({});
                    setLocationId(value);
                  }}
                >
                  <SelectTrigger id="market-from"><SelectValue /></SelectTrigger>
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
              <div className="grid gap-1"><Label htmlFor="market-date">Date</Label><Input id="market-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
              <div className="grid gap-1"><Label htmlFor="market-channel">Channel</Label><Select value={channel} onValueChange={(value) => setChannel(value as typeof channel)}><SelectTrigger id="market-channel"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="farmers_market">Farmers market</SelectItem><SelectItem value="farm_stand">Farm stand</SelectItem><SelectItem value="pickup">Pickup</SelectItem><SelectItem value="direct">Direct</SelectItem></SelectContent></Select></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1"><Label htmlFor="market-payment">Payment</Label><Select value={payment} onValueChange={(value) => setPayment(value as typeof payment)}><SelectTrigger id="market-payment"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="cash">Cash</SelectItem><SelectItem value="card">Card</SelectItem><SelectItem value="venmo">Venmo</SelectItem><SelectItem value="check">Check</SelectItem><SelectItem value="other">Other</SelectItem></SelectContent></Select></div>
              <div className="grid gap-1"><Label htmlFor="market-discount">Discount</Label><Input id="market-discount" type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} /></div>
            </div>
            <div className="grid gap-1"><Label htmlFor="market-customer">Customer</Label><Input id="market-customer" value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Optional" /></div>
            <div className="grid gap-1 border-t pt-3 text-sm">
              {lines.length === 0 && <p className="text-muted-foreground">Tap a row to add it.</p>}
              {lines.map((line) => (
                <div key={line.row.key} className="flex justify-between gap-2">
                  <span className="min-w-0 truncate">{line.quantity} × {line.row.title}</span>
                  <span className="tabular-nums">{formatMoney(line.quantity * line.unitPrice)}</span>
                </div>
              ))}
              {discountAmount > 0 && <div className="flex justify-between text-muted-foreground"><span>Discount</span><span>−{formatMoney(discountAmount)}</span></div>}
            </div>
          </CardContent>
        </Card>
      </div>
      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 px-4 pt-3 pb-[calc(0.75rem+var(--safe-bottom))] backdrop-blur md:px-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <p className="min-w-0 text-sm text-muted-foreground" aria-live="polite" data-testid="market-total">
            {units} {units === 1 ? "item" : "items"}
            {discountAmount > 0 ? ` · ${formatMoney(discountAmount)} off` : ""} ·{" "}
            <span className="text-2xl font-bold tabular-nums text-foreground">{formatMoney(total)}</span>
          </p>
          <Button type="submit" size="lg" className="h-12 shrink-0 px-6 text-base" disabled={salePending || lines.length === 0 || unpriced.length > 0}>
            {salePending ? "Completing…" : "Complete sale"}
          </Button>
        </div>
      </div>
      <ReconciliationCard date={date} loading={reconciliation.isPending} data={reconciliation.data} />
    </ShortcutForm>
  );
}

function MarketRowItem({
  row,
  quantity,
  price,
  onQuantity,
  onPrice,
}: {
  row: MarketRow;
  quantity: number;
  price: string;
  onQuantity: (quantity: number) => void;
  onPrice: (text: string) => void;
}) {
  const full = quantity >= row.left;
  return (
    <li
      data-testid="market-row"
      className={cn(
        "grid gap-2 rounded-lg border bg-card p-3",
        quantity > 0 && "border-primary ring-1 ring-primary/40",
      )}
    >
      <div className="flex items-stretch gap-2">
        <button
          type="button"
          className="min-h-12 min-w-0 flex-1 rounded-md bg-amber-500/10 px-3 py-2 text-left hover:bg-amber-500/20 disabled:opacity-60"
          onClick={() => onQuantity(quantity + 1)}
          disabled={full}
          aria-label={`Add one ${row.title}, ${row.detail}`}
        >
          <span className="block truncate text-base font-semibold">{row.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {row.detail}
            {row.defaultPrice <= 0 && price === "" ? " · No price" : ""}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="size-11"
            aria-label={`Remove one ${row.title}`}
            onClick={() => onQuantity(quantity - 1)}
            disabled={quantity === 0}
          >
            <Minus />
          </Button>
          <Input
            aria-label={`${row.title} quantity`}
            className="h-11 w-14 text-center text-lg font-bold tabular-nums"
            type="number"
            inputMode="numeric"
            min="0"
            max={row.left}
            value={quantity === 0 ? "" : String(quantity)}
            placeholder="0"
            onChange={(event) => onQuantity(Number(event.target.value) || 0)}
          />
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="size-11"
            aria-label={`Add one more ${row.title}`}
            onClick={() => onQuantity(quantity + 1)}
            disabled={full}
          >
            <Plus />
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <span>Price</span>
          <span className="relative">
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
            <Input
              aria-label={`${row.title} price`}
              className="h-9 w-24 pl-5 tabular-nums"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              placeholder="0.00"
              value={price}
              onChange={(event) => onPrice(event.target.value)}
            />
          </span>
        </label>
        {quantity > 0 && (
          <span className="tabular-nums font-medium">
            {formatMoney(quantity * (Number(price) || 0))}
          </span>
        )}
      </div>
    </li>
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

const gridFeatures = dataGridFeatures;

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
