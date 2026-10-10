"use client";

/**
 * Record Sale (s).
 *
 * The items are the point of the form, so they come first, as lines: [Size]
 * [Varietal / lot · N left] [Units] [Unit price] [line total]. Every jar line
 * names its lot (a size with one lot holding stock preselects it; there is no
 * "not traced" choice), counts are what is left at the selling shelf after the
 * other lines, and the running total sits in the sticky footer beside the
 * submit button. The header is one row (date, channel, payment) plus a "Sell
 * now / Reserve for later" switch; the due date appears only when reserving.
 * Customer, location, discount and notes live under "More details", and
 * colonies, equipment and unstocked products under their own disclosure, both
 * closed by default, so the common sale (a jar line or two, cash, now) fits
 * without scrolling. Availability errors from the API surface inline.
 */

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
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
import { ShortcutForm } from "@/components/ui/shortcut-form";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  customerDisplayName,
  useCustomers,
  useWholesalePriceLists,
  type Customer,
} from "@/features/commerce/api";
import {
  LotLinesEditor,
  shelfSkus,
  useLotLines,
  type ShelfSku,
} from "@/features/commerce/lot-lines";
import {
  useStockInventory,
  useStockLocations,
} from "@/features/commerce/stock-locations-api";
import { cn } from "@/lib/utils";

import { Checkbox } from "@/components/ui/checkbox";
import { useEquipmentStock } from "@/features/equipment/hooks";

import { formatMoney, parseNum, todayISO } from "./format";
import {
  useHiveOptions,
  useHiveSaleOffer,
  useProductCatalog,
  useRecordSale,
  useSaleLocations,
  type HiveSaleOffer,
  type SaleLineBody,
} from "./hooks";
import type { CatalogProduct, HoneyInventoryRow, SaleLineKind } from "./types";

interface ColonyDraft {
  hiveId: string;
  label: string;
  unitPrice: string;
  include: Record<string, boolean>;
  equipmentPrice: Record<string, string>;
}

const CHANNELS = [
  "direct",
  "farm_stand",
  "farmers_market",
  "wholesale",
  "pickup",
  "online",
  "gift",
  "consignment",
] as const;
const PAYMENTS = ["cash", "card", "check", "venmo", "paypal", "invoice", "other"] as const;

const saleSchema = z.object({
  date: z.string().min(1, "Date is required"),
  location: z.string(),
  stockLocationId: z.string(),
  customerName: z.string(),
  customerId: z.string(),
  channel: z.string(),
  paymentMethod: z.string(),
  /** "now" applies the sale (paid); "later" reserves it (pending). */
  delivery: z.enum(["now", "later"]),
  discountAmount: z.string(),
  amountPaid: z.string(),
  dueDate: z.string(),
  wholesalePriceListId: z.string(),
  notes: z.string(),
});
type SaleValues = z.infer<typeof saleSchema>;

function saleDefaults(customerId?: string): SaleValues {
  return {
    date: todayISO(),
    location: "",
    stockLocationId: "home",
    customerName: "",
    customerId: customerId ?? "none",
    channel: "direct",
    paymentMethod: "cash",
    delivery: "now",
    discountAmount: "0",
    amountPaid: "",
    dueDate: "",
    wholesalePriceListId: "none",
    notes: "",
  };
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

/** A heading button that opens and closes the section below it. */
function Disclosure({
  open,
  onToggle,
  title,
  summary,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  title: string;
  summary?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-8 items-center gap-1.5 text-left text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="shrink-0">{title}</span>
        {summary && !open ? <span className="truncate font-normal">· {summary}</span> : null}
      </button>
      {open && <div className="grid gap-3 sm:pl-5">{children}</div>}
    </div>
  );
}

export function RecordSaleDialog({
  open,
  onOpenChange,
  inventory,
  customer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inventory: HoneyInventoryRow[];
  /** Opened from a customer: the sale starts with them chosen. */
  customer?: Customer;
}) {
  const mutation = useRecordSale();
  const locations = useSaleLocations();
  const stockLocations = useStockLocations();
  const customers = useCustomers();
  const priceLists = useWholesalePriceLists();
  const hives = useHiveOptions();
  const stock = useEquipmentStock();
  const catalog = useProductCatalog();
  const form = useForm<SaleValues>({
    resolver: zodResolver(saleSchema),
    defaultValues: saleDefaults(customer?.id),
  });
  const [colonies, setColonies] = React.useState<ColonyDraft[]>([]);
  const [offers, setOffers] = React.useState<Record<string, HiveSaleOffer>>({});
  const [pickingHive, setPickingHive] = React.useState("none");
  const [stockLines, setStockLines] = React.useState<
    { stockId: string; quantity: string; unitPrice: string }[]
  >([]);
  const [pickingStock, setPickingStock] = React.useState("none");
  const [productLines, setProductLines] = React.useState<
    { productId: string; quantity: string; unitPrice: string }[]
  >([]);
  const [pickingProduct, setPickingProduct] = React.useState("none");
  const [confirming, setConfirming] = React.useState(false);
  const [lineError, setLineError] = React.useState<string | null>(null);
  const [showExtras, setShowExtras] = React.useState(false);
  const [showDetails, setShowDetails] = React.useState(false);

  // --- what is on the shelf the sale comes off ---
  //
  // The inventory matrix is the one derivation of where every jar stands and
  // which lot it belongs to. Home is the residual of everything consigned
  // out, so a merged count would let a sale take jars that are at a shop.
  const stockInventory = useStockInventory(open);
  const stockLocationId = form.watch("stockLocationId");
  const homeId = stockInventory.data?.locations.find((row) => row.isHome)?.id;
  const sellingFrom = stockLocationId === "home" ? homeId : stockLocationId;
  const sellingFromName =
    stockLocationId === "home"
      ? "at home"
      : `at ${stockLocations.data?.find((row) => row.id === stockLocationId)?.name ?? "that shelf"}`;
  const products = React.useMemo(() => catalog.data?.items ?? [], [catalog.data]);
  const skus = shelfSkus(stockInventory.data?.items, sellingFrom);
  const ozBySize = new Map(inventory.map((row) => [row.jarSizeId, row.honeyOz ?? 0]));
  const priceListId = form.watch("wholesalePriceListId");
  const priceList = (priceLists.data ?? []).find((list) => list.id === priceListId);
  const defaultPrice = React.useCallback(
    (sku: ShelfSku): string => {
      if (sku.jarSizeId) {
        const listed = priceList?.items.find((item) => item.jarSizeId === sku.jarSizeId);
        if (listed) return String(listed.unitPrice);
        const row = inventory.find((item) => item.jarSizeId === sku.jarSizeId);
        const price = row?.defaultPrice ?? sku.unitPrice;
        return price != null ? String(price) : "";
      }
      const product = products.find((item) => item.id === sku.productId);
      const price = product?.defaultPrice ?? sku.unitPrice;
      return price != null && price > 0 ? String(price) : "";
    },
    [priceList, inventory, products],
  );
  const lines = useLotLines(skus, { where: sellingFromName, defaultPrice });
  const { reset: resetLines, setLines } = lines;
  // Products with stock at the shelf are ordinary lines; the extras picker
  // keeps the rest (made to order, raw propolis by the gram).
  const stockedProductIds = new Set(
    skus.flatMap((sku) => (sku.productId ? [sku.productId] : [])),
  );
  const otherProducts = products.filter((product) => !stockedProductIds.has(product.id));

  React.useEffect(() => {
    if (!open) return;
    form.reset(saleDefaults(customer?.id));
    // Each opening is a new sale draft.
    resetLines();
    setColonies([]);
    setOffers({});
    setStockLines([]);
    setProductLines([]);
    setPickingHive("none");
    setPickingStock("none");
    setPickingProduct("none");
    setConfirming(false);
    setLineError(null);
    setShowExtras(false);
    setShowDetails(false);
    mutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resetLines, customer?.id]);

  const jarUnits = lines.filled.reduce(
    (sum, row) => sum + (row.sku.jarSizeId ? row.quantity : 0),
    0,
  );
  const colonySubtotal = colonies.reduce((sum, colony) => sum + (parseNum(colony.unitPrice) ?? 0), 0);
  const hiveEquipmentSubtotal = colonies.reduce((sum, colony) => {
    const offer = offers[colony.hiveId];
    if (!offer) return sum;
    return sum + offer.deployments.reduce((inner, dep) => {
      if (!colony.include[dep.itemId]) return inner;
      const price = parseNum(colony.equipmentPrice[dep.itemId] ?? "") ?? 0;
      return inner + dep.outstanding * price;
    }, 0);
  }, 0);
  const stockSubtotal = stockLines.reduce((sum, line) => {
    const qty = parseNum(line.quantity) ?? 0;
    const price = parseNum(line.unitPrice) ?? 0;
    return sum + (qty > 0 ? qty * price : 0);
  }, 0);
  const productSubtotal = productLines.reduce((sum, line) => {
    const qty = parseNum(line.quantity) ?? 0;
    const price = parseNum(line.unitPrice) ?? 0;
    return sum + (qty > 0 ? qty * price : 0);
  }, 0);
  const extraUnits =
    productLines.reduce((sum, line) => sum + Math.max(0, parseNum(line.quantity) ?? 0), 0) +
    stockLines.reduce((sum, line) => sum + Math.max(0, parseNum(line.quantity) ?? 0), 0) +
    colonies.length;
  const totalUnits = lines.totalUnits + extraUnits;
  const subtotal =
    lines.totalAmount + colonySubtotal + hiveEquipmentSubtotal + stockSubtotal + productSubtotal;
  const discountAmount = Math.min(
    subtotal,
    Math.max(0, parseNum(form.watch("discountAmount")) ?? 0),
  );
  const total = subtotal - discountAmount;

  function resetSaleDraft() {
    form.reset(saleDefaults(customer?.id));
    resetLines();
    setColonies([]);
    setOffers({});
    setStockLines([]);
    setProductLines([]);
    setConfirming(false);
    setLineError(null);
    mutation.reset();
  }

  const sideEffects = React.useMemo(() => {
    let feeders = 0;
    let soldBoxes = 0;
    let returnedBoxes = 0;
    for (const colony of colonies) {
      const offer = offers[colony.hiveId];
      if (!offer) continue;
      feeders += offer.openFeeders;
      for (const dep of offer.deployments) {
        if (colony.include[dep.itemId]) soldBoxes += dep.outstanding;
        else returnedBoxes += dep.outstanding;
      }
    }
    return { feeders, soldBoxes, returnedBoxes, hiveCount: colonies.length };
  }, [colonies, offers]);

  function buildSaleLines(channel: string): SaleLineBody[] | string {
    if (lines.hasErrors) {
      return "Fix the lines marked above first.";
    }
    const saleLines: SaleLineBody[] = lines.filled.map(({ line, sku, quantity }) =>
      sku.jarSizeId
        ? {
            kind: "jar" as const,
            jarSizeId: sku.jarSizeId,
            harvestLotId: line.lot,
            quantity,
            unitPrice: parseNum(line.price) ?? 0,
          }
        : {
            kind: (products.find((item) => item.id === sku.productId)?.kind ??
              sku.kind) as SaleLineKind,
            productId: sku.productId ?? "",
            quantity,
            unitPrice: parseNum(line.price) ?? 0,
          },
    );
    for (const colony of colonies) {
      const price = parseNum(colony.unitPrice);
      if (price === null || price < 0) {
        return "Every colony needs a price — enter 0 for a gift.";
      }
      saleLines.push({ kind: "colony", hiveId: colony.hiveId, quantity: 1, unitPrice: price });
      const offer = offers[colony.hiveId];
      if (!offer) continue;
      const byStock = new Map<string, { qty: number; unitPrice: number }>();
      for (const dep of offer.deployments) {
        if (!colony.include[dep.itemId]) continue;
        const unitPrice = parseNum(colony.equipmentPrice[dep.itemId] ?? "");
        if (unitPrice === null || unitPrice < 0) {
          return "Every sold equipment line needs a price — enter 0 for a gift.";
        }
        const current = byStock.get(dep.itemId);
        if (current) {
          if (current.unitPrice !== unitPrice) {
            return "Same equipment sold from one hive must share a unit price.";
          }
          current.qty += dep.outstanding;
        } else {
          byStock.set(dep.itemId, { qty: dep.outstanding, unitPrice });
        }
      }
      for (const [itemId, row] of byStock) {
        // Gear leaving with the colony is named by its inventory item: the
        // sale consumes it at the deployed location, carrying the hive as the
        // container.
        saleLines.push({ kind: "equipment", itemId, quantity: row.qty, unitPrice: row.unitPrice });
      }
    }
    for (const line of stockLines) {
      const qty = parseNum(line.quantity) ?? 0;
      if (qty <= 0) continue;
      const price = parseNum(line.unitPrice);
      if (price === null || price < 0) {
        return "Every stock equipment line needs a price — enter 0 for a gift.";
      }
      saleLines.push({ kind: "equipment", equipmentStockId: line.stockId, quantity: qty, unitPrice: price });
    }
    for (const line of productLines) {
      const qty = parseNum(line.quantity) ?? 0;
      if (qty <= 0) continue;
      const price = parseNum(line.unitPrice);
      if (price === null || price < 0) {
        return "Every hive-product line needs a price — enter 0 for a gift.";
      }
      const product = products.find((item) => item.id === line.productId);
      if (!product) {
        return "Unknown catalog product.";
      }
      saleLines.push({ kind: product.kind, productId: line.productId, quantity: qty, unitPrice: price });
    }
    if (channel !== "gift" && saleLines.some((line) => line.unitPrice === 0)) {
      return "Paid sales need a price on every line. Use the gift channel to give items away.";
    }
    if (saleLines.length === 0) {
      return "Add at least one jar, hive product, colony, or equipment line.";
    }
    return saleLines;
  }

  const submitSale = (resetAfter: boolean) => form.handleSubmit((values) => {
    const saleLines = buildSaleLines(values.channel);
    if (typeof saleLines === "string") {
      setLineError(saleLines);
      setConfirming(false);
      return;
    }
    if (!confirming && (sideEffects.hiveCount > 0 || sideEffects.feeders > 0)) {
      setLineError(null);
      setConfirming(true);
      return;
    }
    setLineError(null);
    if (values.stockLocationId !== "home" && saleLines.some(
      (line) => line.kind === "colony" || line.kind === "equipment",
    )) {
      setLineError("Colony and equipment sales come off home, not a stock location.");
      setConfirming(false);
      return;
    }
    const orderStatus = values.delivery === "now" ? "paid" : "pending";
    mutation.mutate(
      {
        date: values.date,
        location: values.location.trim() || undefined,
        stockLocationId: values.stockLocationId === "home" ? undefined : values.stockLocationId,
        customerId: values.customerId === "none" ? undefined : values.customerId,
        customerName: values.customerName.trim() || undefined,
        channel: values.channel as "direct",
        paymentMethod: values.paymentMethod as "cash",
        discountAmount,
        amountPaid: values.amountPaid.trim()
          ? Number(values.amountPaid)
          : orderStatus === "paid"
            ? total
            : 0,
        orderStatus,
        dueDate: values.delivery === "later" ? values.dueDate || undefined : undefined,
        wholesalePriceListId:
          values.wholesalePriceListId === "none" ? undefined : values.wholesalePriceListId,
        lines: saleLines,
        notes: values.notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          if (resetAfter) resetSaleDraft();
          else onOpenChange(false);
        },
      },
    );
  });
  const onSubmit = submitSale(false);
  const onSubmitAndReset = submitSale(true);

  const apiError = mutation.error instanceof Error ? mutation.error.message : null;
  const { errors } = form.formState;
  const delivery = form.watch("delivery");
  const channel = form.watch("channel");
  const otherShelves = (stockLocations.data ?? []).filter(
    (location) => location.isActive && !location.isHome && !location.isConsignment,
  );
  const customerId = form.watch("customerId");
  const savedCustomer = (customers.data ?? []).find((customer) => customer.id === customerId);
  const detailsSummary = [
    savedCustomer ? customerDisplayName(savedCustomer) : form.watch("customerName").trim(),
    form.watch("location").trim(),
    discountAmount > 0 ? `${formatMoney(discountAmount)} off` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const extrasCount = colonies.length + stockLines.length + productLines.length;

  function applyPriceList(listId: string) {
    form.setValue("wholesalePriceListId", listId);
    const list = priceLists.data?.find((item) => item.id === listId);
    if (!list) return;
    setLines((current) =>
      current.map((line) => {
        const sku = lines.skuByKey.get(line.sku);
        const price = sku?.jarSizeId
          ? list.items.find((item) => item.jarSizeId === sku.jarSizeId)
          : undefined;
        return price ? { ...line, price: String(price.unitPrice) } : line;
      }),
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{customer ? `Record a sale for ${customerDisplayName(customer)}` : "Record a sale"}</DialogTitle>
          <DialogDescription>
            Each jar line names its varietal / lot. Past dates are allowed.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          onSubmit={onSubmit}
          onSubmitAndReset={onSubmitAndReset}
          onEscape={() => onOpenChange(false)}
          className="grid gap-4"
        >
          {apiError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>{apiError}</span>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="col-span-2 grid gap-1.5 sm:col-span-1">
              <Label htmlFor="sale-date">Date</Label>
              <Input id="sale-date" type="date" {...form.register("date")} />
              <FieldError message={errors.date?.message} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sale-channel">Channel</Label>
              <Select
                value={channel}
                onValueChange={(value) => {
                  form.setValue("channel", value);
                  if (value !== "wholesale") form.setValue("wholesalePriceListId", "none");
                }}
              >
                <SelectTrigger id="sale-channel" className="w-full capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNELS.map((value) => (
                    <SelectItem key={value} value={value} className="capitalize">
                      {humanize(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sale-payment">Payment</Label>
              <Select
                value={form.watch("paymentMethod")}
                onValueChange={(value) => form.setValue("paymentMethod", value)}
              >
                <SelectTrigger id="sale-payment" className="w-full capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENTS.map((value) => (
                    <SelectItem key={value} value={value} className="capitalize">
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <span className="text-sm font-medium" id="sale-delivery-label">
                Delivery
              </span>
              <div
                role="radiogroup"
                aria-labelledby="sale-delivery-label"
                className="inline-flex rounded-md border p-0.5"
              >
                {(
                  [
                    ["now", "Sell now"],
                    ["later", "Reserve for later"],
                  ] as const
                ).map(([value, text]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={delivery === value}
                    onClick={() => form.setValue("delivery", value)}
                    className={cn(
                      "min-h-8 rounded px-3 text-sm transition-colors",
                      delivery === value
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
            {delivery === "later" && (
              <div className="grid gap-1.5">
                <Label htmlFor="sale-due-date">Due date</Label>
                <Input id="sale-due-date" type="date" {...form.register("dueDate")} />
              </div>
            )}
            {otherShelves.length > 0 && (
              <div className="grid min-w-40 gap-1.5">
                <Label htmlFor="sale-shelf">Sell from</Label>
                <Select
                  value={stockLocationId}
                  onValueChange={(value) => {
                    form.setValue("stockLocationId", value);
                    // The lines were counted against the old shelf.
                    resetLines();
                  }}
                >
                  <SelectTrigger id="sale-shelf" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="home">Home</SelectItem>
                    {otherShelves.map((location) => (
                      <SelectItem key={location.id} value={location.id}>
                        {location.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {channel === "wholesale" && (
              <div className="grid min-w-48 gap-1.5">
                <Label htmlFor="sale-price-list">Price list</Label>
                <Select value={priceListId} onValueChange={applyPriceList}>
                  <SelectTrigger id="sale-price-list" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No price list</SelectItem>
                    {(priceLists.data ?? []).map((list) => (
                      <SelectItem key={list.id} value={list.id}>
                        {list.name} · {formatMoney(list.minimumOrderAmount)} min
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <section aria-label="Items" className="grid gap-1.5">
            {stockInventory.isPending ? (
              <Skeleton className="h-20" />
            ) : (
              <LotLinesEditor
                state={lines}
                skus={skus}
                where={sellingFromName}
                idPrefix="sale"
                lineTestId="sale-line"
                emptyText={`No jars or products with stock ${sellingFromName}.`}
                sizeHint={(sku) => {
                  const oz = ozBySize.get(sku.jarSizeId ?? "");
                  return oz ? ` · ${oz} oz` : "";
                }}
              />
            )}
            <FieldError message={lineError ?? undefined} />
          </section>

          <Disclosure
            open={showExtras}
            onToggle={() => setShowExtras((value) => !value)}
            title="Add colonies, equipment or other products"
            summary={extrasCount > 0 ? `${extrasCount} added` : undefined}
          >
            <ColonyEquipmentFields
              colonies={colonies}
              setColonies={setColonies}
              offers={offers}
              setOffers={setOffers}
              pickingHive={pickingHive}
              setPickingHive={setPickingHive}
              stockLines={stockLines}
              setStockLines={setStockLines}
              pickingStock={pickingStock}
              setPickingStock={setPickingStock}
              hiveOptions={hives.data ?? []}
              stockRows={stock.data ?? []}
            />
            <CatalogProductFields
              products={otherProducts}
              productLines={productLines}
              setProductLines={setProductLines}
              pickingProduct={pickingProduct}
              setPickingProduct={setPickingProduct}
            />
          </Disclosure>

          <Disclosure
            open={showDetails}
            onToggle={() => setShowDetails((value) => !value)}
            title="More details"
            summary={detailsSummary || "customer, location, discount, notes"}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="sale-customer-pick">Customer</Label>
                <Select
                  value={customerId}
                  onValueChange={(value) => form.setValue("customerId", value)}
                >
                  <SelectTrigger id="sale-customer-pick" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No saved customer</SelectItem>
                    {(customers.data ?? []).map((customer) => (
                      <SelectItem key={customer.id} value={customer.id}>
                        {customerDisplayName(customer)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  id="sale-customer"
                  aria-label="Customer name"
                  placeholder="Or a name for the receipt"
                  {...form.register("customerName")}
                />
              </div>
              <div className="grid content-start gap-1.5">
                <Label htmlFor="sale-location">Location</Label>
                <Input
                  id="sale-location"
                  list="sale-locations"
                  placeholder="e.g. Farmers market"
                  {...form.register("location")}
                />
                <datalist id="sale-locations">
                  {(locations.data ?? []).map((location) => (
                    <option key={location} value={location} />
                  ))}
                </datalist>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="sale-discount">Discount</Label>
                <Input
                  id="sale-discount"
                  type="number"
                  min="0"
                  step="0.01"
                  {...form.register("discountAmount")}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="sale-paid">Amount paid</Label>
                <Input
                  id="sale-paid"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder={formatMoney(delivery === "now" ? total : 0)}
                  {...form.register("amountPaid")}
                />
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="sale-notes">Notes</Label>
                <Textarea
                  id="sale-notes"
                  rows={2}
                  placeholder="Optional notes"
                  {...form.register("notes")}
                />
              </div>
            </div>
          </Disclosure>

          {confirming && sideEffects.hiveCount > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              This sale marks {sideEffects.hiveCount}{" "}
              {sideEffects.hiveCount === 1 ? "hive" : "hives"} sold
              {sideEffects.feeders > 0
                ? `, closes ${sideEffects.feeders} open ${sideEffects.feeders === 1 ? "feeder" : "feeders"}`
                : ""}
              {sideEffects.soldBoxes > 0 ? `, sells ${sideEffects.soldBoxes} pieces with the hive` : ""}
              {sideEffects.returnedBoxes > 0
                ? `, and returns ${sideEffects.returnedBoxes} pieces to storage`
                : ""}
              . Confirm to record.
            </div>
          )}
          <DialogFooter className="sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground" aria-live="polite" data-testid="sale-total">
              {jarUnits > 0
                ? `${jarUnits} ${jarUnits === 1 ? "jar" : "jars"}`
                : `${totalUnits} ${totalUnits === 1 ? "unit" : "units"}`}
              {jarUnits > 0 && totalUnits > jarUnits ? ` + ${totalUnits - jarUnits} more` : ""}
              {discountAmount > 0 ? ` · ${formatMoney(discountAmount)} off` : ""}
              {" · "}
              <span className="text-base font-semibold tabular-nums text-foreground">
                {formatMoney(total)}
              </span>
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending || lines.hasErrors}>
                {mutation.isPending
                  ? "Saving…"
                  : confirming
                    ? "Confirm sale"
                    : delivery === "now"
                      ? "Record sale"
                      : "Reserve"}
              </Button>
            </div>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

function ColonyEquipmentFields({
  colonies,
  setColonies,
  offers,
  setOffers,
  pickingHive,
  setPickingHive,
  stockLines,
  setStockLines,
  pickingStock,
  setPickingStock,
  hiveOptions,
  stockRows,
}: {
  colonies: ColonyDraft[];
  setColonies: React.Dispatch<React.SetStateAction<ColonyDraft[]>>;
  offers: Record<string, HiveSaleOffer>;
  setOffers: React.Dispatch<React.SetStateAction<Record<string, HiveSaleOffer>>>;
  pickingHive: string;
  setPickingHive: (value: string) => void;
  stockLines: { stockId: string; quantity: string; unitPrice: string }[];
  setStockLines: React.Dispatch<
    React.SetStateAction<{ stockId: string; quantity: string; unitPrice: string }[]>
  >;
  pickingStock: string;
  setPickingStock: (value: string) => void;
  hiveOptions: { id: string; positionLabel: string; apiaryName: string; status: string }[];
  stockRows: { id: string; typeName: string; available: number; unitCostCents: number | null }[];
}) {
  const selected = new Set(colonies.map((colony) => colony.hiveId));
  const sellableHives = hiveOptions.filter(
    (hive) => hive.status === "active" && !selected.has(hive.id),
  );
  const usedStock = new Set(stockLines.map((line) => line.stockId));

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label>Colonies</Label>
        <Select
          value={pickingHive}
          onValueChange={(value) => {
            setPickingHive("none");
            if (value === "none") return;
            const hive = hiveOptions.find((item) => item.id === value);
            if (!hive) return;
            setColonies((current) => [
              ...current,
              {
                hiveId: hive.id,
                label: `${hive.positionLabel} · ${hive.apiaryName}`,
                unitPrice: "",
                include: {},
                equipmentPrice: {},
              },
            ]);
          }}
        >
          <SelectTrigger><SelectValue placeholder="Add a hive" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Add a hive…</SelectItem>
            {sellableHives.map((hive) => (
              <SelectItem key={hive.id} value={hive.id}>
                {hive.positionLabel} · {hive.apiaryName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {colonies.map((colony) => (
          <div key={colony.hiveId} className="grid gap-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{colony.label}</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setColonies((current) =>
                    current.filter((item) => item.hiveId !== colony.hiveId),
                  )
                }
              >
                Remove
              </Button>
            </div>
            <div className="grid gap-1.5">
              <Label>Colony price</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={colony.unitPrice}
                onChange={(event) =>
                  setColonies((current) =>
                    current.map((item) =>
                      item.hiveId === colony.hiveId
                        ? { ...item, unitPrice: event.target.value }
                        : item,
                    ),
                  )
                }
              />
            </div>
            <HiveOfferLoader
              hiveId={colony.hiveId}
              onOffer={(offer) => {
                setOffers((current) =>
                  current[offer.hiveId] ? current : { ...current, [offer.hiveId]: offer },
                );
                setColonies((current) =>
                  current.map((item) => {
                    if (item.hiveId !== offer.hiveId || Object.keys(item.include).length > 0) {
                      return item;
                    }
                    const include: Record<string, boolean> = {};
                    const equipmentPrice: Record<string, string> = {};
                    for (const dep of offer.deployments) {
                      include[dep.itemId] = true;
                      equipmentPrice[dep.itemId] =
                        dep.unitCostCents != null
                          ? String(dep.unitCostCents / 100)
                          : "";
                    }
                    return { ...item, include, equipmentPrice };
                  }),
                );
              }}
            />
            {(offers[colony.hiveId]?.deployments ?? []).map((dep) => (
              <label key={dep.itemId} className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={colony.include[dep.itemId] ?? false}
                  onCheckedChange={(checked) =>
                    setColonies((current) =>
                      current.map((item) =>
                        item.hiveId === colony.hiveId
                          ? {
                              ...item,
                              include: { ...item.include, [dep.itemId]: checked === true },
                            }
                          : item,
                      ),
                    )
                  }
                />
                <span className="grid flex-1 gap-1">
                  <span>
                    {dep.outstanding} × {dep.typeName}
                    <span className="ml-1 text-xs text-muted-foreground">
                      (sold with hive)
                    </span>
                  </span>
                  {colony.include[dep.itemId] && (
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Unit price"
                      value={colony.equipmentPrice[dep.itemId] ?? ""}
                      onChange={(event) =>
                        setColonies((current) =>
                          current.map((item) =>
                            item.hiveId === colony.hiveId
                              ? {
                                  ...item,
                                  equipmentPrice: {
                                    ...item.equipmentPrice,
                                    [dep.itemId]: event.target.value,
                                  },
                                }
                              : item,
                          ),
                        )
                      }
                    />
                  )}
                </span>
              </label>
            ))}
            {offers[colony.hiveId] && (
              <p className="text-xs text-muted-foreground">
                Unchecked gear returns to storage. Closes{" "}
                {offers[colony.hiveId].openFeeders} open{" "}
                {offers[colony.hiveId].openFeeders === 1 ? "feeder" : "feeders"}.
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="grid gap-1.5">
        <Label>Equipment from stock</Label>
        <Select
          value={pickingStock}
          onValueChange={(value) => {
            setPickingStock("none");
            if (value === "none") return;
            const row = stockRows.find((item) => item.id === value);
            if (!row) return;
            setStockLines((current) => [
              ...current,
              {
                stockId: row.id,
                quantity: "1",
                unitPrice:
                  row.unitCostCents != null ? String(row.unitCostCents / 100) : "",
              },
            ]);
          }}
        >
          <SelectTrigger><SelectValue placeholder="Add equipment" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Add equipment…</SelectItem>
            {stockRows
              .filter((row) => row.available > 0 && !usedStock.has(row.id))
              .map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  {row.typeName} · {row.available} available
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        {stockLines.map((line) => {
          const row = stockRows.find((item) => item.id === line.stockId);
          return (
            <div key={line.stockId} className="grid grid-cols-[1fr_5rem_6rem_auto] items-end gap-2">
              <p className="text-sm">{row?.typeName ?? "Equipment"}</p>
              <Input
                type="number"
                min="1"
                value={line.quantity}
                onChange={(event) =>
                  setStockLines((current) =>
                    current.map((item) =>
                      item.stockId === line.stockId
                        ? { ...item, quantity: event.target.value }
                        : item,
                    ),
                  )
                }
              />
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="Price"
                value={line.unitPrice}
                onChange={(event) =>
                  setStockLines((current) =>
                    current.map((item) =>
                      item.stockId === line.stockId
                        ? { ...item, unitPrice: event.target.value }
                        : item,
                    ),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setStockLines((current) =>
                    current.filter((item) => item.stockId !== line.stockId),
                  )
                }
              >
                Remove
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CatalogProductFields({
  products,
  productLines,
  setProductLines,
  pickingProduct,
  setPickingProduct,
}: {
  products: CatalogProduct[];
  productLines: { productId: string; quantity: string; unitPrice: string }[];
  setProductLines: React.Dispatch<
    React.SetStateAction<{ productId: string; quantity: string; unitPrice: string }[]>
  >;
  pickingProduct: string;
  setPickingProduct: (value: string) => void;
}) {
  const used = new Set(productLines.map((line) => line.productId));
  const sellable = products.filter(
    (product) =>
      !used.has(product.id) &&
      (product.isActive || product.onHand > 0 || product.inStock),
  );
  return (
    <div className="grid gap-1.5">
      <Label>Hive products</Label>
      <Select
        value={pickingProduct}
        onValueChange={(value) => {
          setPickingProduct("none");
          if (value === "none") return;
          const product = products.find((item) => item.id === value);
          if (!product) return;
          setProductLines((current) => [
            ...current,
            {
              productId: product.id,
              quantity: "1",
              unitPrice: product.defaultPrice > 0 ? String(product.defaultPrice) : "",
            },
          ]);
        }}
      >
        <SelectTrigger><SelectValue placeholder="Add a product" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Add a product…</SelectItem>
          {sellable.map((product) => (
            <SelectItem key={product.id} value={product.id}>
              {product.sizeLabel ? `${product.name} · ${product.sizeLabel}` : product.name}
              {product.onHand > 0 ? ` · ${product.onHand} on hand` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {productLines.map((line) => {
        const product = products.find((item) => item.id === line.productId);
        return (
          <div key={line.productId} className="grid grid-cols-[1fr_5rem_6rem_auto] items-end gap-2">
            <p className="text-sm">
              {product
                ? product.sizeLabel
                  ? `${product.name} · ${product.sizeLabel}`
                  : product.name
                : "Product"}
            </p>
            <Input
              type="number"
              min="1"
              value={line.quantity}
              onChange={(event) =>
                setProductLines((current) =>
                  current.map((item) =>
                    item.productId === line.productId
                      ? { ...item, quantity: event.target.value }
                      : item,
                  ),
                )
              }
            />
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="Price"
              value={line.unitPrice}
              onChange={(event) =>
                setProductLines((current) =>
                  current.map((item) =>
                    item.productId === line.productId
                      ? { ...item, unitPrice: event.target.value }
                      : item,
                  ),
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                setProductLines((current) =>
                  current.filter((item) => item.productId !== line.productId),
                )
              }
            >
              Remove
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function HiveOfferLoader({
  hiveId,
  onOffer,
}: {
  hiveId: string;
  onOffer: (offer: HiveSaleOffer) => void;
}) {
  const offer = useHiveSaleOffer(hiveId);
  const onOfferRef = React.useRef(onOffer);
  React.useEffect(() => {
    onOfferRef.current = onOffer;
  }, [onOffer]);
  React.useEffect(() => {
    if (offer.data) onOfferRef.current(offer.data);
  }, [offer.data]);
  if (offer.isPending) {
    return <p className="text-xs text-muted-foreground">Loading hive gear…</p>;
  }
  if (offer.isError) {
    return (
      <p className="text-xs text-destructive">
        {offer.error instanceof Error ? offer.error.message : "Could not load hive gear"}
      </p>
    );
  }
  return null;
}
