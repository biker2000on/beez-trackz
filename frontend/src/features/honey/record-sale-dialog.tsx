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
import { Textarea } from "@/components/ui/textarea";

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
  notes: z.string(),
});
type SaleValues = z.infer<typeof saleSchema>;

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
  const form = useForm<SaleValues>({
    resolver: zodResolver(saleSchema),
    defaultValues: { date: todayISO(), location: "", customerName: "", notes: "" },
  });
  const [lines, setLines] = React.useState<JarLineValue[]>([]);
  const [lineError, setLineError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    form.reset({ date: todayISO(), location: "", customerName: "", notes: "" });
    // Each opening is a new sale draft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLines(makeJarLines(inventory, { withPrice: true }));
    setLineError(null);
    mutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inventory]);

  const total = lines.reduce((sum, line) => {
    const qty = parseNum(line.quantity) ?? 0;
    const price = parseNum(line.unitPrice ?? "") ?? 0;
    return sum + (qty > 0 ? qty * price : 0);
  }, 0);

  const onSubmit = form.handleSubmit((values) => {
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
        customerName: values.customerName.trim() || undefined,
        lines: saleLines,
        notes: values.notes.trim() || undefined,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  });

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
        <form onSubmit={onSubmit} className="grid gap-4">
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
            <Input
              id="sale-customer"
              placeholder="Optional customer name"
              {...form.register("customerName")}
            />
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
            <span className="text-sm text-muted-foreground">Total</span>
            <span className="text-base font-semibold tabular-nums">
              {formatMoney(total)}
            </span>
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
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}
