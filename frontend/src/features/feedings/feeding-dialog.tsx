"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { ApiError } from "@/lib/api";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { todayInput } from "@/features/hives/lib";
import { parseFeedingQuantity } from "@/lib/units";
import { useUnits } from "@/lib/use-units";
import {
  FEEDER_TYPES,
  FEEDING_TYPES,
  QUANTITY_UNITS,
  useCreateFeeding,
} from "./hooks";

const feedingSchema = z.object({
  dateFed: z.string().min(1, "Date is required"),
  type: z.string().min(1, "Feed type is required"),
  quantity: z.string().trim().min(1, "Quantity is required"),
  quantityUnit: z.string().min(1, "Unit is required"),
  feederType: z.string(),
  notes: z.string(),
});

type FeedingValues = z.infer<typeof feedingSchema>;

const NO_FEEDER = "none";

export function FeedingDialog({
  open,
  onOpenChange,
  hiveId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hiveId: string;
}) {
  const { units, formatFeeding } = useUnits();
  const createFeeding = useCreateFeeding();

  const form = useForm<FeedingValues>({
    resolver: zodResolver(feedingSchema),
    defaultValues: {
      dateFed: todayInput(),
      type: "sugar_syrup_1to1",
      quantity: "",
      quantityUnit: "quarts",
      feederType: NO_FEEDER,
      notes: "",
    },
  });

  React.useEffect(() => {
    if (open) {
      form.reset({
        dateFed: todayInput(),
        type: "sugar_syrup_1to1",
        quantity: "",
        quantityUnit: "quarts",
        feederType: NO_FEEDER,
        notes: "",
      });
    }
  }, [open, form]);

  const watched = form.watch();

  async function onSubmit(values: FeedingValues, resetAfter = false) {
    const parsed = parseFeedingQuantity(values.quantity, units);
    const hasSuffix = /\s*[a-zA-Z]+$/.test(values.quantity.trim());
    const quantity = hasSuffix && parsed
      ? parsed.quantity
      : Number(values.quantity);
    const quantityUnit = hasSuffix && parsed ? parsed.unit : values.quantityUnit;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      form.setError("quantity", { message: "Quantity must be greater than zero" });
      return;
    }
    try {
      await createFeeding.mutateAsync({
        hiveId,
        dateFed: values.dateFed,
        type: values.type,
        quantity,
        quantityUnit,
        feederType: values.feederType === NO_FEEDER ? null : values.feederType,
        notes: values.notes.trim() === "" ? null : values.notes,
      });
      toast.success("Feeding recorded");
      if (resetAfter) {
        form.reset({
          dateFed: todayInput(),
          type: "sugar_syrup_1to1",
          quantity: "",
          quantityUnit: "quarts",
          feederType: NO_FEEDER,
          notes: "",
        });
        requestAnimationFrame(() => form.setFocus("quantity"));
      } else {
        onOpenChange(false);
      }
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not record the feeding",
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Feed hive</DialogTitle>
          <DialogDescription>
            Record what you fed and how much.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          onSubmit={form.handleSubmit((values) => onSubmit(values))}
          onSubmitAndReset={form.handleSubmit((values) => onSubmit(values, true))}
          onEscape={() => onOpenChange(false)}
          className="grid gap-4"
          noValidate
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="feeding-date">Date</Label>
              <Input
                id="feeding-date"
                type="date"
                aria-invalid={form.formState.errors.dateFed ? true : undefined}
                {...form.register("dateFed")}
              />
              {form.formState.errors.dateFed && (
                <p className="text-sm text-destructive" role="alert">
                  {form.formState.errors.dateFed.message}
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label>Feed type</Label>
              <Select
                value={watched.type}
                onValueChange={(value) => form.setValue("type", value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FEEDING_TYPES.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="feeding-quantity">Quantity ({watched.quantityUnit})</Label>
              <Input
                id="feeding-quantity"
                inputMode="decimal"
                placeholder={`e.g. 2 ${watched.quantityUnit}, 2 kg or 2 L`}
                aria-invalid={
                  form.formState.errors.quantity ? true : undefined
                }
                {...form.register("quantity")}
              />
              {form.formState.errors.quantity && (
                <p className="text-sm text-destructive" role="alert">
                  {form.formState.errors.quantity.message}
                </p>
              )}
              {(() => {
                const parsed = parseFeedingQuantity(watched.quantity, units);
                const hasSuffix = /\s*[a-zA-Z]+$/.test(watched.quantity.trim());
                if (!hasSuffix || !parsed) return null;
                const preview = formatFeeding(parsed.quantity, parsed.unit);
                return preview ? (
                  <p className="text-xs text-muted-foreground">Records as {preview}</p>
                ) : null;
              })()}
            </div>
            <div className="grid gap-2">
              <Label>Unit</Label>
              <Select
                value={watched.quantityUnit}
                onValueChange={(value) => form.setValue("quantityUnit", value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUANTITY_UNITS.map((unit) => (
                    <SelectItem key={unit} value={unit}>
                      {unit}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Feeder</Label>
            <Select
              value={watched.feederType}
              onValueChange={(value) => form.setValue("feederType", value)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_FEEDER}>
                  No feeder — fed directly
                </SelectItem>
                {FEEDER_TYPES.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {watched.feederType === NO_FEEDER
                ? "Recorded as a one-time feed; nothing stays on the hive to track."
                : "The feeder stays on the hive until you refill or close it."}
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="feeding-notes">Notes</Label>
            <Textarea id="feeding-notes" rows={2} {...form.register("notes")} />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? "Saving…" : "Record feeding"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}
