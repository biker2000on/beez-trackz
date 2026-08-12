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

import { formatMoney, parseNum, todayISO } from "./format";
import { useRecordSale, useSaleLocations } from "./hooks";
import {
  JarLinesEditor,
  makeJarLines,
  type JarLineValue,
} from "./jar-lines-editor";
import type { HoneyInventoryRow } from "./types";

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
  const form = useForm<SaleValues>({
    resolver: zodResolver(saleSchema),
    defaultValues: saleDefaults(),
  });
  const [lines, setLines] = React.useState<JarLineValue[]>([]);
  const [lineError, setLineError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    form.reset(saleDefaults());
    // Each opening is a new sale draft.
    setLines(makeJarLines(inventory, { withPrice: true }));
    setLineError(null);
    mutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inventory]);

  const subtotal = lines.reduce((sum, line) => {
    const qty = parseNum(line.quantity) ?? 0;
    const price = parseNum(line.unitPrice ?? "") ?? 0;
    return sum + (qty > 0 ? qty * price : 0);
  }, 0);
  const discountAmount = Math.min(subtotal, Math.max(0, parseNum(form.watch("discountAmount")) ?? 0));
  const total = subtotal - discountAmount;

  function resetSaleDraft() {
    form.reset(saleDefaults());
    setLines(makeJarLines(inventory, { withPrice: true }));
    setLineError(null);
    mutation.reset();
    requestAnimationFrame(() => form.setFocus("location"));
  }

  const submitSale = (resetAfter: boolean) => form.handleSubmit((values) => {
    // A blank or unparseable price on a line being sold must be an error,
    // not a silent $0 sale understating revenue. Explicit "0" still works
    // for a deliberate giveaway.
    const missingPrice = lines.some((line) => {
      const qty = parseNum(line.quantity) ?? 0;
      const price = parseNum(line.unitPrice ?? "");
      return qty > 0 && (price === null || price < 0);
    });
    if (missingPrice) {
      setLineError(
        "Every jar line with a quantity needs a price — enter 0 for a giveaway.",
      );
      return;
    }
    const saleLines = lines
      .map((line) => ({
        jarSizeId: line.jarSizeId,
        quantity: parseNum(line.quantity) ?? 0,
        unitPrice: parseNum(line.unitPrice ?? "") ?? 0,
      }))
      .filter((line) => line.quantity > 0);
    if (saleLines.length === 0) {
      setLineError("Add at least one jar.");
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
            Jars sold, priced per size. Prices prefill from your jar-size
            defaults.
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
                  <SelectItem key={lot.id} value={lot.id}>
                    {lot.lotCode}{lot.season ? ` · ${lot.season}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Assigning a lot enables batch and season profitability.
            </p>
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
              {mutation.isPending ? "Saving…" : "Record sale"}
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
