"use client";

/**
 * Market day: the stall's point of sale.
 *
 * The screen lists what can actually be sold, one row per varietal × size ×
 * lot with stock at the shelf being sold from: "Sourwood · Qt ·
 * 2026-SOURWOOD · 36 left · $30". Nothing at zero is ever shown — not a size,
 * not a lot. Two lots of the same varietal and size are two rows, told apart
 * by lot code. Catalog products with stock are rows of their own. Every row
 * posts its harvest lot, so every jar sold here is traceable.
 *
 * Order of operations, on a phone and on a desk: pick the items (the name is
 * a big tap target that adds one; − and + sit beside a typed count), then in
 * the sticky footer read the total, tap how they paid (Cash / Card / Venmo /
 * Other), then Complete sale — which first shows the sale back (items, total,
 * payment) and completes on the sheet's own Complete sale. The button stays
 * disabled until there is at least one item and a payment. Date, channel,
 * customer and discount are optional and sit below the items; the channel
 * remembers the last one used. The price on a row is read-only until the
 * amount is tapped.
 */

import * as React from "react";
import Link from "next/link";
import {
  createColumnHelper,
  useTable,
} from "@tanstack/react-table";
import { ChevronDown, Minus, Plus, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import { shortSizeName } from "./size-names";
import {
  useStockInventory,
  useStockLocationSale,
} from "./stock-locations-api";

/** One sellable row: a jar size from one lot, or a catalog product. */
interface MarketRow {
  key: string;
  /** The heading as shown: "Sourwood · Qt", or the product name. */
  title: string;
  /** The heading with the catalog's own size name, for accessible names. */
  fullTitle: string;
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

type Channel = "farmers_market" | "farm_stand" | "pickup" | "direct";
type Payment = "cash" | "card" | "venmo" | "check" | "other";

const CHANNELS: { value: Channel; label: string }[] = [
  { value: "farmers_market", label: "Farmers market" },
  { value: "farm_stand", label: "Farm stand" },
  { value: "pickup", label: "Pickup" },
  { value: "direct", label: "Direct" },
];

/** The footer's segmented row. Check is recorded as Other from the stall. */
const PAYMENTS: { value: Payment; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "venmo", label: "Venmo" },
  { value: "other", label: "Other" },
];

const CHANNEL_KEY = "market-day:channel";
const CHANNEL_EVENT = "market-day:channel-changed";
const OTHER = "Other products";
const NO_VARIETAL = "Unnamed varietal";

function isChannel(value: unknown): value is Channel {
  return CHANNELS.some((channel) => channel.value === value);
}

// The channel is the one thing that is the same all day, so it is kept in
// localStorage and read as an external store: the server render assumes the
// default and the client swaps in what was saved, with no effect-set state.
let memoryChannel: Channel = "farmers_market";

function readChannel(): Channel {
  try {
    const saved = window.localStorage.getItem(CHANNEL_KEY);
    if (isChannel(saved)) return saved;
  } catch {
    // Private mode or blocked storage: the in-memory value stands.
  }
  return memoryChannel;
}

function writeChannel(value: Channel) {
  memoryChannel = value;
  try {
    window.localStorage.setItem(CHANNEL_KEY, value);
  } catch {
    // Not remembered across reloads; still used for this sale.
  }
  window.dispatchEvent(new Event(CHANNEL_EVENT));
}

function subscribeChannel(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANNEL_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANNEL_EVENT, onChange);
  };
}

function priceText(value: number): string {
  return value > 0 ? String(value) : "";
}

function paymentLabel(payment: Payment | null): string {
  return PAYMENTS.find((entry) => entry.value === payment)?.label ?? "Check";
}

function channelLabel(channel: Channel): string {
  return CHANNELS.find((entry) => entry.value === channel)?.label ?? channel;
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
  const channel = React.useSyncExternalStore(
    subscribeChannel,
    readChannel,
    () => "farmers_market" as Channel,
  );
  // Chosen per sale: nothing is assumed about how they paid.
  const [payment, setPayment] = React.useState<Payment | null>(null);
  const [discount, setDiscount] = React.useState("0");
  const [customer, setCustomer] = React.useState("");
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  // Market day sells from ONE place at a time. Home is the default and
  // usually the only choice; an empty id means "home, and we have not
  // heard back from the locations request yet".
  const [locationId, setLocationId] = React.useState("");
  const stock = useStockInventory();
  const locationSale = useStockLocationSale(locationId);

  // The footer is fixed, so the page needs exactly its height of room at
  // the bottom; it is measured rather than guessed because it is three rows
  // on a phone and one on a desk.
  const [footerHeight, setFooterHeight] = React.useState(176);
  const footerObserver = React.useRef<ResizeObserver | null>(null);
  const footerRef = React.useCallback((element: HTMLDivElement | null) => {
    footerObserver.current?.disconnect();
    footerObserver.current = null;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => setFooterHeight(Math.ceil(element.getBoundingClientRect().height));
    measure();
    footerObserver.current = new ResizeObserver(measure);
    footerObserver.current.observe(element);
  }, []);

  const cartCount = Object.values(cart).reduce((sum, qty) => sum + qty, 0);
  React.useEffect(() => {
    onCartCountChange?.(cartCount);
  }, [cartCount, onCartCountChange]);

  if (inventory.isPending || stock.isPending) return <Skeleton className="h-72" />;
  if (inventory.isError || stock.isError) {
    return (
      <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-6 text-center text-base">
        Could not load market inventory.{" "}
        <button
          type="button"
          className="font-medium text-primary underline-offset-4 hover:underline"
          onClick={() => {
            void inventory.refetch();
            void stock.refetch();
          }}
        >
          Try again
        </button>
      </p>
    );
  }

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
        const varietal = lot.varietalName ?? NO_VARIETAL;
        rows.push({
          key: `jar:${sku.jarSizeId}|${lot.harvestLotId}`,
          title: `${varietal} · ${shortSizeName(sku.label)}`,
          fullTitle: `${varietal} · ${sku.label}`,
          detail: `${lot.lotCode ?? "Lot"} · ${lot.at} left`,
          group: varietal,
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
    const title = product.sizeLabel ? `${product.name} · ${product.sizeLabel}` : product.name;
    rows.push({
      key: `product:${product.id}`,
      title,
      fullTitle: title,
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
      const title = product.sizeLabel ? `${product.name} · ${product.sizeLabel}` : product.name;
      rows.push({
        key: `product:${product.id}`,
        title,
        fullTitle: title,
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

  // Low stock is only worth a banner for a size this shelf can actually
  // sell: a size with no lot here is not on the table at all.
  const sizesWithLots = new Set(
    skus.filter((sku) => sku.jarSizeId && sku.lots.length > 0).map((sku) => sku.jarSizeId),
  );
  const lowRows = (lowStock.data ?? []).filter((row) => sizesWithLots.has(row.jarSizeId));

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
    setPayment(null);
    setConfirming(false);
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
  const canComplete =
    !salePending && lines.length > 0 && unpriced.length === 0 && payment !== null;

  function openConfirm() {
    if (!canComplete) return;
    setConfirming(true);
  }

  function checkout() {
    if (!canComplete || payment === null) return;
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
          onError: (error) => {
            setConfirming(false);
            toast.error(error instanceof Error ? error.message : "Sale failed");
          },
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
        setConfirming(false);
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

  const detailsSummary = [
    date === todayISO() ? "Today" : date,
    channelLabel(channel),
    customer.trim() ? customer.trim() : "No customer",
    discountAmount > 0 ? `${formatMoney(discountAmount)} off` : "No discount",
  ].join(" · ");

  return (
    <ShortcutForm
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        openConfirm();
      }}
      onSubmitAndReset={openConfirm}
    >
      <div className="grid gap-3" aria-live="polite">
        {lowRows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-base">
            <TriangleAlert className="size-4 text-amber-600" />
            <span className="font-medium">Low stock:</span>
            {lowRows.map((row) => (
              <Badge key={row.jarSizeId} variant="outline">
                {shortSizeName(row.label)} {row.onHand}/{row.threshold}
              </Badge>
            ))}
          </div>
        )}
        {unpriced.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-base text-destructive">
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
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-base text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{saleError}</span>
          </div>
        )}
        {saleQueued && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-base">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <span>Sale saved offline — it syncs when you reconnect. Stock is not updated yet.</span>
          </div>
        )}
      </div>

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
            <SelectTrigger id="market-from" className="w-full sm:max-w-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {locations.map((location) => (
                <SelectItem
                  key={location.id}
                  value={location.id}
                  disabled={location.isConsignment}
                >
                  {location.name}
                  {location.isConsignment
                    ? " · consignment, the shop reports its sales"
                    : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {awayUnits > 0 && sellingHome && (
            <p className="text-sm text-muted-foreground">
              {awayUnits} units are at another location and are not on
              this table.
            </p>
          )}
        </div>
      )}

      <div className="grid min-w-0 gap-5" aria-label="Products for sale">
        {groups.length === 0 && (
          <p className="rounded-md border border-dashed p-6 text-center text-base text-muted-foreground">
            Nothing with stock {sellingHome ? "at home" : "at this location"} to sell.
          </p>
        )}
        {groups.map((group) => (
          <section key={group.name} className="grid gap-2" aria-label={group.name}>
            <h2 className="break-words text-base font-semibold">
              {group.name}
            </h2>
            <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
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
          <p className="text-sm text-muted-foreground">
            {unattributed.map((sku) => `${sku.unattributed} ${shortSizeName(sku.label)}`).join(", ")} carry no
            lot and are not listed: every jar sold here names its varietal.
          </p>
        )}
      </div>

      <section className="rounded-lg border bg-card" aria-label="Sale details">
        <button
          type="button"
          className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-left"
          aria-expanded={detailsOpen}
          aria-controls="market-details"
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <span className="grid min-w-0 gap-0.5">
            <span className="text-base font-semibold">Sale details</span>
            <span className="break-words text-sm text-muted-foreground">{detailsSummary}</span>
          </span>
          <ChevronDown
            className={cn("size-4 shrink-0 transition-transform", detailsOpen && "rotate-180")}
            aria-hidden
          />
        </button>
        <div id="market-details" hidden={!detailsOpen} className="grid gap-4 border-t px-4 py-4 sm:grid-cols-2">
          <div className="grid gap-1"><Label htmlFor="market-date">Date</Label><Input id="market-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="grid gap-1"><Label htmlFor="market-channel">Channel</Label><Select value={channel} onValueChange={(value) => writeChannel(value as Channel)}><SelectTrigger id="market-channel" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{CHANNELS.map((entry) => <SelectItem key={entry.value} value={entry.value}>{entry.label}</SelectItem>)}</SelectContent></Select></div>
          <div className="grid gap-1"><Label htmlFor="market-customer">Customer</Label><Input id="market-customer" value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Optional" /></div>
          <div className="grid gap-1"><Label htmlFor="market-discount">Discount</Label><Input id="market-discount" type="number" min="0" step="0.01" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} /></div>
        </div>
      </section>

      <ReconciliationCard date={date} loading={reconciliation.isPending} data={reconciliation.data} />

      {/* Room for the fixed footer, measured from the footer itself. */}
      <div aria-hidden style={{ height: footerHeight }} />

      <div
        ref={footerRef}
        className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 px-4 pt-3 pb-[calc(0.75rem+var(--safe-bottom))] backdrop-blur md:px-8"
      >
        <div className="mx-auto grid max-w-6xl gap-2 md:grid-cols-[auto_1fr_auto] md:items-center md:gap-4">
          <p className="min-w-0 text-base text-muted-foreground" aria-live="polite" data-testid="market-total">
            {units} {units === 1 ? "item" : "items"}
            {discountAmount > 0 ? ` · ${formatMoney(discountAmount)} off` : ""} ·{" "}
            <span className="text-2xl font-bold tabular-nums text-foreground">{formatMoney(total)}</span>
          </p>
          <div className="flex items-center gap-2 md:justify-center">
            <span id="market-paid-by" className="shrink-0 text-sm font-medium text-muted-foreground">
              Paid by
            </span>
            <div
              role="radiogroup"
              aria-labelledby="market-paid-by"
              className="grid flex-1 grid-cols-4 gap-1 rounded-lg bg-muted p-1 md:max-w-sm"
            >
              {PAYMENTS.map((entry) => {
                const selected = payment === entry.value;
                return (
                  <button
                    key={entry.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-testid={`market-pay-${entry.value}`}
                    className={cn(
                      "min-h-11 rounded-md px-1 text-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selected
                        ? "bg-card text-foreground shadow-sm ring-1 ring-primary"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setPayment(entry.value)}
                  >
                    {entry.label}
                  </button>
                );
              })}
            </div>
          </div>
          <Button
            type="button"
            size="lg"
            className="h-12 w-full px-6 text-base md:w-auto"
            disabled={!canComplete}
            onClick={openConfirm}
          >
            {salePending ? "Completing…" : "Complete sale"}
          </Button>
        </div>
      </div>

      <Sheet open={confirming} onOpenChange={(open) => { if (!salePending) setConfirming(open); }}>
        <SheetContent side="bottom" className="pb-[calc(1.5rem+var(--safe-bottom))]">
          <div className="mx-auto grid w-full max-w-md gap-4">
            <SheetHeader>
              <SheetTitle className="text-xl">Complete this sale?</SheetTitle>
              <SheetDescription className="text-base">
                {units} {units === 1 ? "item" : "items"} · paid by {paymentLabel(payment)} · {channelLabel(channel)}
                {customer.trim() ? ` · ${customer.trim()}` : ""}
              </SheetDescription>
            </SheetHeader>
            <ul className="grid gap-1.5 text-base" aria-label="Items in this sale">
              {lines.map((line) => (
                <li key={line.row.key} className="flex justify-between gap-3">
                  <span className="min-w-0 break-words">{line.quantity} × {line.row.title}</span>
                  <span className="shrink-0 tabular-nums">{formatMoney(line.quantity * line.unitPrice)}</span>
                </li>
              ))}
              {discountAmount > 0 && (
                <li className="flex justify-between gap-3 text-muted-foreground">
                  <span>Discount</span>
                  <span className="tabular-nums">−{formatMoney(discountAmount)}</span>
                </li>
              )}
              <li className="flex justify-between gap-3 border-t pt-2 font-semibold">
                <span>Total · {paymentLabel(payment)}</span>
                <span className="text-xl tabular-nums">{formatMoney(total)}</span>
              </li>
            </ul>
            <SheetFooter className="sm:flex-row-reverse">
              <Button
                type="button"
                size="lg"
                className="h-12 text-base"
                disabled={!canComplete}
                onClick={checkout}
              >
                {salePending ? "Completing…" : "Complete sale"}
              </Button>
              <SheetClose asChild>
                <Button type="button" variant="outline" size="lg" className="h-12 text-base" disabled={salePending}>
                  Back to items
                </Button>
              </SheetClose>
            </SheetFooter>
          </div>
        </SheetContent>
      </Sheet>
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
      <button
        type="button"
        className="min-h-12 w-full rounded-md bg-amber-500/10 px-3 py-2 text-left hover:bg-amber-500/20 disabled:opacity-60"
        onClick={() => onQuantity(quantity + 1)}
        disabled={full}
        aria-label={`Add one ${row.fullTitle}, ${row.detail}`}
      >
        <span className="block break-words text-base font-semibold leading-snug">{row.title}</span>
        <span className="block break-words text-sm text-muted-foreground">
          {row.detail}
          {row.defaultPrice <= 0 && price === "" ? " · No price" : ""}
        </span>
      </button>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <PriceCell title={row.fullTitle} value={price} onChange={onPrice} />
          {quantity > 0 && (
            <span className="truncate text-sm font-medium tabular-nums text-muted-foreground">
              = {formatMoney(quantity * (Number(price) || 0))}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="size-11"
            aria-label={`Remove one ${row.fullTitle}`}
            onClick={() => onQuantity(quantity - 1)}
            disabled={quantity === 0}
          >
            <Minus />
          </Button>
          <Input
            aria-label={`${row.fullTitle} quantity`}
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
            aria-label={`Add one more ${row.fullTitle}`}
            onClick={() => onQuantity(quantity + 1)}
            disabled={full}
          >
            <Plus />
          </Button>
        </div>
      </div>
    </li>
  );
}

/**
 * The row's price: read-only until the amount is tapped, then an input.
 * Enter or leaving the field keeps what was typed; Escape puts the old
 * price back. Either way the amount is read-only again afterwards.
 */
function PriceCell({
  title,
  value,
  onChange,
}: {
  title: string;
  value: string;
  onChange: (text: string) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const before = React.useRef(value);
  const amount = Number(value) || 0;
  if (!editing) {
    return (
      <button
        type="button"
        className={cn(
          "min-h-11 shrink-0 rounded-md px-2 text-base tabular-nums underline decoration-dotted underline-offset-4 hover:bg-muted",
          amount > 0 ? "text-foreground" : "text-destructive",
        )}
        aria-label={`${title} price ${amount > 0 ? formatMoney(amount) : "not set"}, change`}
        onClick={() => {
          before.current = value;
          setEditing(true);
        }}
      >
        {amount > 0 ? formatMoney(amount) : "Set price"}
      </button>
    );
  }
  return (
    <span className="relative shrink-0">
      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
      <Input
        autoFocus
        aria-label={`${title} price`}
        className="h-11 w-28 pl-5 text-base tabular-nums"
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        placeholder="0.00"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            event.nativeEvent.stopImmediatePropagation();
            onChange(before.current);
            setEditing(false);
          } else if (event.key === "Enter") {
            event.preventDefault();
            setEditing(false);
          }
        }}
        onBlur={() => setEditing(false)}
      />
    </span>
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
