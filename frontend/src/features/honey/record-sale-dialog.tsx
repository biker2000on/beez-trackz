"use client";

/**
 * Record Sale (s): date, location with autocomplete, per-size lines with
 * price prefilled from jar-size defaults and on-hand shown, live total.
 * Availability errors from the API ("Not enough X…") surface inline.
 */

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { TriangleAlert } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useCustomers,
  useHarvestLots,
  useWholesalePriceLists,
} from "@/features/commerce/api";

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
import type { CatalogProduct } from "./types";
import {
  JarLinesEditor,
  makeJarLines,
  type JarLineValue,
} from "./jar-lines-editor";
import type { HoneyInventoryRow } from "./types";

interface ColonyDraft {
  hiveId: string;
  label: string;
  unitPrice: string;
  include: Record<string, boolean>;
  equipmentPrice: Record<string, string>;
}

const saleSchema = z.object({
  date: z.string().min(1, "Date is required"),
  location: z.string(),
  customerName: z.string(),
  customerId: z.string(),
  harvestLotId: z.string(),
  channel: z.string(),
  paymentMethod: z.string(),
  orderStatus: z.string(),
  discountAmount: z.string(),
  amountPaid: z.string(),
  dueDate: z.string(),
  wholesalePriceListId: z.string(),
  notes: z.string(),
});
type SaleValues = z.infer<typeof saleSchema>;

function saleDefaults(): SaleValues {
  return {
    date: todayISO(),
    location: "",
    customerName: "",
    customerId: "none",
    harvestLotId: "none",
    channel: "direct",
    paymentMethod: "cash",
    orderStatus: "paid",
    discountAmount: "0",
    amountPaid: "",
    dueDate: "",
    wholesalePriceListId: "none",
    notes: "",
  };
}

export function RecordSaleDialog({
  open,
  onOpenChange,
  inventory,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inventory: HoneyInventoryRow[];
}) {
  const mutation = useRecordSale();
  const locations = useSaleLocations();
  const customers = useCustomers();
  const lots = useHarvestLots();
  const priceLists = useWholesalePriceLists();
  const hives = useHiveOptions();
  const stock = useEquipmentStock();
  const catalog = useProductCatalog();
  const form = useForm<SaleValues>({
    resolver: zodResolver(saleSchema),
    defaultValues: saleDefaults(),
  });
  const [lines, setLines] = React.useState<JarLineValue[]>([]);
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

  React.useEffect(() => {
    if (!open) return;
    form.reset(saleDefaults());
    // Each opening is a new sale draft.
    setLines(makeJarLines(inventory, { withPrice: true }));
    setColonies([]);
    setOffers({});
    setStockLines([]);
    setProductLines([]);
    setPickingHive("none");
    setPickingStock("none");
    setPickingProduct("none");
    setConfirming(false);
    setLineError(null);
    mutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inventory]);

  const jarSubtotal = lines.reduce((sum, line) => {
    const qty = parseNum(line.quantity) ?? 0;
    const price = parseNum(line.unitPrice ?? "") ?? 0;
    return sum + (qty > 0 ? qty * price : 0);
  }, 0);
  const colonySubtotal = colonies.reduce((sum, colony) => {
    return sum + (parseNum(colony.unitPrice) ?? 0);
  }, 0);
  const hiveEquipmentSubtotal = colonies.reduce((sum, colony) => {
    const offer = offers[colony.hiveId];
    if (!offer) return sum;
    return sum + offer.deployments.reduce((inner, dep) => {
      if (!colony.include[dep.id]) return inner;
      const price = parseNum(colony.equipmentPrice[dep.id] ?? "") ?? 0;
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
  const subtotal = jarSubtotal + colonySubtotal + hiveEquipmentSubtotal + stockSubtotal + productSubtotal;
  const discountAmount = Math.min(subtotal, Math.max(0, parseNum(form.watch("discountAmount")) ?? 0));
  const total = subtotal - discountAmount;

  function resetSaleDraft() {
    form.reset(saleDefaults());
    setLines(makeJarLines(inventory, { withPrice: true }));
    setColonies([]);
    setOffers({});
    setStockLines([]);
    setProductLines([]);
    setConfirming(false);
    setLineError(null);
    mutation.reset();
    requestAnimationFrame(() => form.setFocus("location"));
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
        if (colony.include[dep.id]) soldBoxes += dep.outstanding;
        else returnedBoxes += dep.outstanding;
      }
    }
    return { feeders, soldBoxes, returnedBoxes, hiveCount: colonies.length };
  }, [colonies, offers]);

  function buildSaleLines(channel: string): SaleLineBody[] | string {
    const missingPrice = lines.some((line) => {
      const qty = parseNum(line.quantity) ?? 0;
      const price = parseNum(line.unitPrice ?? "");
      return qty > 0 && (price === null || price < 0);
    });
    if (missingPrice) {
      return "Every jar line with a quantity needs a price — enter 0 for a gift.";
    }
    const saleLines: SaleLineBody[] = lines
      .map((line) => ({
        kind: "jar" as const,
        jarSizeId: line.jarSizeId,
        quantity: parseNum(line.quantity) ?? 0,
        unitPrice: parseNum(line.unitPrice ?? "") ?? 0,
      }))
      .filter((line) => line.quantity > 0);
    for (const colony of colonies) {
      const price = parseNum(colony.unitPrice);
      if (price === null || price < 0) {
        return "Every colony needs a price — enter 0 for a gift.";
      }
      saleLines.push({
        kind: "colony",
        hiveId: colony.hiveId,
        quantity: 1,
        unitPrice: price,
      });
      const offer = offers[colony.hiveId];
      if (!offer) continue;
      const byStock = new Map<string, { qty: number; unitPrice: number }>();
      for (const dep of offer.deployments) {
        if (!colony.include[dep.id]) continue;
        const unitPrice = parseNum(colony.equipmentPrice[dep.id] ?? "");
        if (unitPrice === null || unitPrice < 0) {
          return "Every sold equipment line needs a price — enter 0 for a gift.";
        }
        const current = byStock.get(dep.stockId);
        if (current) {
          if (current.unitPrice !== unitPrice) {
            return "Same equipment sold from one hive must share a unit price.";
          }
          current.qty += dep.outstanding;
        } else {
          byStock.set(dep.stockId, { qty: dep.outstanding, unitPrice });
        }
      }
      for (const [stockId, row] of byStock) {
        saleLines.push({
          kind: "equipment",
          equipmentStockId: stockId,
          quantity: row.qty,
          unitPrice: row.unitPrice,
        });
      }
    }
    for (const line of stockLines) {
      const qty = parseNum(line.quantity) ?? 0;
      if (qty <= 0) continue;
      const price = parseNum(line.unitPrice);
      if (price === null || price < 0) {
        return "Every stock equipment line needs a price — enter 0 for a gift.";
      }
      saleLines.push({
        kind: "equipment",
        equipmentStockId: line.stockId,
        quantity: qty,
        unitPrice: price,
      });
    }
    for (const line of productLines) {
      const qty = parseNum(line.quantity) ?? 0;
      if (qty <= 0) continue;
      const price = parseNum(line.unitPrice);
      if (price === null || price < 0) {
        return "Every hive-product line needs a price — enter 0 for a gift.";
      }
      const product = (catalog.data?.items ?? []).find((item) => item.id === line.productId);
      if (!product) {
        return "Unknown catalog product.";
      }
      saleLines.push({
        kind: product.kind,
        productId: line.productId,
        quantity: qty,
        unitPrice: price,
      });
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
    mutation.mutate(
      {
        date: values.date,
        location: values.location.trim() || undefined,
        customerId: values.customerId === "none" ? undefined : values.customerId,
        harvestLotId: values.harvestLotId === "none" ? undefined : values.harvestLotId,
        customerName: values.customerName.trim() || undefined,
        channel: values.channel as "direct",
        paymentMethod: values.paymentMethod as "cash",
        discountAmount,
        amountPaid: values.amountPaid.trim() ? Number(values.amountPaid) : values.orderStatus === "paid" || values.orderStatus === "fulfilled" ? total : 0,
        orderStatus: values.orderStatus as "paid",
        dueDate: values.dueDate || undefined,
        wholesalePriceListId: values.wholesalePriceListId === "none" ? undefined : values.wholesalePriceListId,
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

  const apiError =
    mutation.error instanceof Error ? mutation.error.message : null;
  const { errors } = form.formState;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a sale</DialogTitle>
          <DialogDescription>
            One customer, one payment, one receipt. Mix jars, hive products,
            colonies, and equipment. Past dates are allowed.
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
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="sale-date">Date</Label>
              <Input id="sale-date" type="date" {...form.register("date")} />
              <FieldError message={errors.date?.message} />
            </div>
            <div className="grid gap-1.5">
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
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Channel</Label>
              <Select
                value={form.watch("channel")}
                onValueChange={(value) => {
                  form.setValue("channel", value);
                  if (value !== "wholesale") {
                    form.setValue("wholesalePriceListId", "none");
                  }
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["direct", "farm_stand", "farmers_market", "wholesale", "pickup", "online", "gift", "consignment"].map((value) => <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Payment</Label>
              <Select value={form.watch("paymentMethod")} onValueChange={(value) => form.setValue("paymentMethod", value)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{["cash", "card", "check", "venmo", "paypal", "invoice", "other"].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Order status</Label>
              <Select value={form.watch("orderStatus")} onValueChange={(value) => form.setValue("orderStatus", value)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{["draft", "pending", "paid", "fulfilled"].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sale-due-date">Due date</Label>
              <Input id="sale-due-date" type="date" {...form.register("dueDate")} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <JarLinesEditor
              rows={inventory}
              value={lines}
              onChange={setLines}
              showPrice
              showOnHand
            />
            <FieldError message={lineError ?? undefined} />
          </div>
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
            products={catalog.data?.items ?? []}
            productLines={productLines}
            setProductLines={setProductLines}
            pickingProduct={pickingProduct}
            setPickingProduct={setPickingProduct}
          />
          {confirming && sideEffects.hiveCount > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              This sale marks {sideEffects.hiveCount}{" "}
              {sideEffects.hiveCount === 1 ? "hive" : "hives"} sold
              {sideEffects.feeders > 0
                ? `, closes ${sideEffects.feeders} open ${sideEffects.feeders === 1 ? "feeder" : "feeders"}`
                : ""}
              {sideEffects.soldBoxes > 0
                ? `, sells ${sideEffects.soldBoxes} pieces with the hive`
                : ""}
              {sideEffects.returnedBoxes > 0
                ? `, and returns ${sideEffects.returnedBoxes} pieces to storage`
                : ""}
              . Confirm to record.
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="sale-customer">Customer</Label>
            <Select value={form.watch("customerId")} onValueChange={(value) => form.setValue("customerId", value)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No saved customer</SelectItem>
                {(customers.data ?? []).map((customer) => <SelectItem key={customer.id} value={customer.id}>{customer.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input
              id="sale-customer"
              placeholder="Optional customer name"
              {...form.register("customerName")}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Harvest lot</Label>
            <Select
              value={form.watch("harvestLotId")}
              onValueChange={(value) => form.setValue("harvestLotId", value)}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unassigned</SelectItem>
                {(lots.data ?? []).map((lot) => (
                  <SelectItem key={lot.id} value={lot.id} disabled={lot.lockout?.locked}>
                    {lot.lotCode}{lot.season ? ` · ${lot.season}` : ""}
                    {lot.lockout?.locked ? " · locked" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(() => {
              const selected = (lots.data ?? []).find((lot) => lot.id === form.watch("harvestLotId"));
              if (!selected?.lockout?.locked) {
                return (
                  <p className="text-xs text-muted-foreground">
                    Assigning a lot enables batch and season profitability.
                  </p>
                );
              }
              return (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {selected.lockout.message}
                </p>
              );
            })()}
          </div>
          {form.watch("channel") === "wholesale" && (
            <div className="grid gap-1.5">
              <Label>Wholesale price list</Label>
              <Select
                value={form.watch("wholesalePriceListId")}
                onValueChange={(value) => {
                  form.setValue("wholesalePriceListId", value);
                  const list = priceLists.data?.find((item) => item.id === value);
                  if (list) {
                    setLines((current) => current.map((line) => {
                      const price = list.items.find((item) => item.jarSizeId === line.jarSizeId);
                      return price ? { ...line, unitPrice: String(price.unitPrice) } : line;
                    }));
                  }
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">No price list</SelectItem>{(priceLists.data ?? []).map((list) => <SelectItem key={list.id} value={list.id}>{list.name} · {formatMoney(list.minimumOrderAmount)} min</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label htmlFor="sale-discount">Discount</Label><Input id="sale-discount" type="number" min="0" step="0.01" {...form.register("discountAmount")} /></div>
            <div className="grid gap-1.5"><Label htmlFor="sale-paid">Amount paid</Label><Input id="sale-paid" type="number" min="0" step="0.01" placeholder={formatMoney(total)} {...form.register("amountPaid")} /></div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sale-notes">Notes</Label>
            <Textarea
              id="sale-notes"
              rows={2}
              placeholder="Optional notes"
              {...form.register("notes")}
            />
          </div>
          <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2">
            <span className="text-sm text-muted-foreground">Subtotal {formatMoney(subtotal)}{discountAmount > 0 ? ` · discount ${formatMoney(discountAmount)}` : ""}</span>
            <span className="text-base font-semibold tabular-nums">{formatMoney(total)}</span>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending
                ? "Saving…"
                : confirming
                  ? "Confirm sale"
                  : "Record sale"}
            </Button>
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
                      include[dep.id] = true;
                      equipmentPrice[dep.id] =
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
              <label key={dep.id} className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={colony.include[dep.id] ?? false}
                  onCheckedChange={(checked) =>
                    setColonies((current) =>
                      current.map((item) =>
                        item.hiveId === colony.hiveId
                          ? {
                              ...item,
                              include: { ...item.include, [dep.id]: checked === true },
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
                  {colony.include[dep.id] && (
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="Unit price"
                      value={colony.equipmentPrice[dep.id] ?? ""}
                      onChange={(event) =>
                        setColonies((current) =>
                          current.map((item) =>
                            item.hiveId === colony.hiveId
                              ? {
                                  ...item,
                                  equipmentPrice: {
                                    ...item.equipmentPrice,
                                    [dep.id]: event.target.value,
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
