"use client";

/**
 * Per-row stock dialogs: deploy to hive (quantity capped at available),
 * adjust count (± with a reason), edit storage location, and the adjustment
 * history viewer.
 */

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

import { formatDate, parseNum, todayISO } from "./format";
import {
  useAdjustStock,
  useDeployEquipment,
  useHiveOptions,
  useStockAdjustments,
  useUpdateStock,
} from "./hooks";
import { ADJUSTMENT_REASONS, type EquipmentStockRow } from "./types";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

interface StockDialogProps {
  stock: EquipmentStockRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// --- deploy to hive ---

const deploySchema = z.object({
  hiveId: z.string().min(1, "Hive is required"),
  quantity: z
    .string()
    .refine(
      (v) => Number.isInteger(parseNum(v) ?? NaN) && (parseNum(v) ?? 0) >= 1,
      "Quantity must be at least 1",
    ),
  notes: z.string(),
});
type DeployValues = z.infer<typeof deploySchema>;

export function DeployDialog({ stock, open, onOpenChange }: StockDialogProps) {
  const hives = useHiveOptions();
  const mutation = useDeployEquipment();
  const form = useForm<DeployValues>({
    resolver: zodResolver(deploySchema),
    defaultValues: { hiveId: "", quantity: "1", notes: "" },
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset({ hiveId: "", quantity: "1", notes: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onSubmit = form.handleSubmit((values) => {
    const quantity = parseNum(values.quantity)!;
    if (quantity > stock.available) {
      form.setError("quantity", {
        message: `Only ${stock.available} available`,
      });
      return;
    }
    mutation.mutate(
      {
        stockId: stock.id,
        hiveId: values.hiveId,
        quantity,
        notes: values.notes.trim() || undefined,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  });

  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deploy {stock.typeName}</DialogTitle>
          <DialogDescription>
            {stock.available} in storage available to deploy.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>Hive</Label>
            <Select
              value={form.watch("hiveId")}
              onValueChange={(value) =>
                form.setValue("hiveId", value, { shouldValidate: true })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a hive" />
              </SelectTrigger>
              <SelectContent>
                {(hives.data ?? []).map((hive) => (
                  <SelectItem key={hive.id} value={hive.id}>
                    {hive.positionLabel} — {hive.apiaryName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={errors.hiveId?.message} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="deploy-quantity">Quantity</Label>
            <Input
              id="deploy-quantity"
              type="number"
              inputMode="numeric"
              step={1}
              min={1}
              max={stock.available}
              {...form.register("quantity")}
            />
            <FieldError message={errors.quantity?.message} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="deploy-notes">Notes</Label>
            <Textarea
              id="deploy-notes"
              rows={2}
              placeholder="Optional notes"
              {...form.register("notes")}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending || stock.available < 1}
            >
              {mutation.isPending ? "Deploying…" : "Deploy"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- adjust count ---

const adjustSchema = z.object({
  quantity: z
    .string()
    .refine(
      (v) => Number.isInteger(parseNum(v) ?? NaN) && (parseNum(v) ?? 0) !== 0,
      "Enter a non-zero whole number",
    ),
  reason: z.string().min(1, "Reason is required"),
  date: z.string().min(1, "Date is required"),
  notes: z.string(),
});
type AdjustValues = z.infer<typeof adjustSchema>;

export function AdjustStockDialog({
  stock,
  open,
  onOpenChange,
}: StockDialogProps) {
  const mutation = useAdjustStock();
  const form = useForm<AdjustValues>({
    resolver: zodResolver(adjustSchema),
    defaultValues: {
      quantity: "",
      reason: "purchased",
      date: todayISO(),
      notes: "",
    },
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset({ quantity: "", reason: "purchased", date: todayISO(), notes: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const delta = parseNum(form.watch("quantity")) ?? 0;

  const onSubmit = form.handleSubmit((values) => {
    mutation.mutate(
      {
        stockId: stock.id,
        quantity: parseNum(values.quantity)!,
        reason: values.reason,
        date: values.date,
        notes: values.notes.trim() || undefined,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  });

  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust {stock.typeName}</DialogTitle>
          <DialogDescription>
            Currently {stock.totalOwned} owned. Use a positive number to add
            stock, negative to remove.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="adjust-quantity">± Quantity</Label>
              <Input
                id="adjust-quantity"
                type="number"
                inputMode="numeric"
                step={1}
                placeholder="e.g. 5 or -2"
                {...form.register("quantity")}
              />
              <FieldError message={errors.quantity?.message} />
            </div>
            <div className="grid gap-1.5">
              <Label>Reason</Label>
              <Select
                value={form.watch("reason")}
                onValueChange={(value) =>
                  form.setValue("reason", value, { shouldValidate: true })
                }
              >
                <SelectTrigger className="capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ADJUSTMENT_REASONS.map((reason) => (
                    <SelectItem key={reason} value={reason} className="capitalize">
                      {reason}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={errors.reason?.message} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="adjust-date">Date</Label>
            <Input id="adjust-date" type="date" {...form.register("date")} />
            <FieldError message={errors.date?.message} />
          </div>
          {delta !== 0 && Number.isInteger(delta) && (
            <p className="text-xs text-muted-foreground">
              New total:{" "}
              <span className="font-medium tabular-nums">
                {stock.totalOwned + delta}
              </span>
            </p>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="adjust-notes">Notes</Label>
            <Textarea
              id="adjust-notes"
              rows={2}
              placeholder="Optional notes"
              {...form.register("notes")}
            />
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
              {mutation.isPending ? "Saving…" : "Apply adjustment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- edit location ---

const locationSchema = z.object({
  storageLocation: z.string(),
});
type LocationValues = z.infer<typeof locationSchema>;

export function EditLocationDialog({
  stock,
  open,
  onOpenChange,
}: StockDialogProps) {
  const mutation = useUpdateStock();
  const form = useForm<LocationValues>({
    resolver: zodResolver(locationSchema),
    defaultValues: { storageLocation: stock.storageLocation ?? "" },
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset({ storageLocation: stock.storageLocation ?? "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stock.storageLocation]);

  const onSubmit = form.handleSubmit((values) => {
    mutation.mutate(
      {
        stockId: stock.id,
        storageLocation: values.storageLocation.trim() || null,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Storage location</DialogTitle>
          <DialogDescription>
            Where spare {stock.typeName.toLowerCase()} stock is kept.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="stock-location">Location</Label>
            <Input
              id="stock-location"
              placeholder="e.g. Garage shelf B"
              {...form.register("storageLocation")}
            />
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
              {mutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- adjustment history ---

export function HistoryDialog({ stock, open, onOpenChange }: StockDialogProps) {
  const adjustments = useStockAdjustments(stock.id, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{stock.typeName} history</DialogTitle>
          <DialogDescription>
            Every stock adjustment, most recent first.
          </DialogDescription>
        </DialogHeader>
        {adjustments.isPending ? (
          <div className="grid gap-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : adjustments.isError ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Could not load history.
          </p>
        ) : adjustments.data.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No adjustments recorded yet.
          </p>
        ) : (
          <ul className="grid max-h-80 gap-2 overflow-y-auto">
            {adjustments.data.map((adjustment) => (
              <li
                key={adjustment.id}
                className="flex items-center gap-3 rounded-lg border p-3"
              >
                <Badge
                  variant={adjustment.quantity >= 0 ? "accent" : "destructive"}
                  className="w-12 justify-center tabular-nums"
                >
                  {adjustment.quantity > 0 ? "+" : ""}
                  {adjustment.quantity}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium capitalize">
                    {adjustment.reason}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {formatDate(adjustment.date)}
                    {adjustment.notes ? ` · ${adjustment.notes}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
