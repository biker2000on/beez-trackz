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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { todayInput } from "@/features/hives/lib";
import {
  FEEDER_TYPES,
  FEEDING_TYPES,
  QUANTITY_UNITS,
  useCreateFeeding,
} from "./hooks";

const feedingSchema = z.object({
  dateFed: z.string().min(1, "Date is required"),
  type: z.string().min(1, "Feed type is required"),
  quantity: z
    .string()
    .trim()
    .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, {
      message: "Quantity must be greater than zero",
    }),
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

  async function onSubmit(values: FeedingValues) {
    try {
      await createFeeding.mutateAsync({
        hiveId,
        dateFed: values.dateFed,
        type: values.type,
        quantity: Number(values.quantity),
        quantityUnit: values.quantityUnit,
        feederType: values.feederType === NO_FEEDER ? null : values.feederType,
        notes: values.notes.trim() === "" ? null : values.notes,
      });
      toast.success("Feeding recorded");
      onOpenChange(false);
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
        <form
          onSubmit={form.handleSubmit(onSubmit)}
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
              <Label htmlFor="feeding-quantity">Quantity</Label>
              <Input
                id="feeding-quantity"
                type="number"
                min="0"
                step="0.1"
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
            <Label>Feeder type</Label>
            <Select
              value={watched.feederType}
              onValueChange={(value) => form.setValue("feederType", value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Optional" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_FEEDER}>Not specified</SelectItem>
                {FEEDER_TYPES.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
        </form>
      </DialogContent>
    </Dialog>
  );
}
