"use client";

/**
 * Partial return of a deployment. A return records how many came back, why,
 * and in what condition — gear that comes back broken lands in the damaged
 * pile instead of quietly rejoining available stock.
 */

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { parseNum, todayISO } from "./format";
import { useReturnDeployment } from "./hooks";
import {
  CONDITION_LABELS,
  RETURN_CONDITIONS,
  RETURN_REASONS,
  reasonLabel,
  type ActiveDeployment,
  type ReturnCondition,
} from "./types";

const returnSchema = z.object({
  quantity: z
    .string()
    .refine(
      (v) => Number.isInteger(parseNum(v) ?? NaN) && (parseNum(v) ?? 0) >= 1,
      "Quantity must be at least 1",
    ),
  reason: z.string().min(1, "Reason is required"),
  condition: z.string().min(1, "Condition is required"),
  date: z.string().min(1, "Date is required"),
  notes: z.string(),
});
type ReturnValues = z.infer<typeof returnSchema>;

export function ReturnDeploymentDialog({
  deployment,
  open,
  onOpenChange,
}: {
  deployment: ActiveDeployment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useReturnDeployment();
  const outstanding = deployment.outstanding;

  const form = useForm<ReturnValues>({
    resolver: zodResolver(returnSchema),
    defaultValues: {
      quantity: String(outstanding),
      reason: "season_end",
      condition: "good",
      date: todayISO(),
      notes: "",
    },
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset({
      quantity: String(outstanding),
      reason: "season_end",
      condition: "good",
      date: todayISO(),
      notes: "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, outstanding]);

  const quantity = parseNum(form.watch("quantity")) ?? 0;

  const onSubmit = form.handleSubmit((values) => {
    const returning = parseNum(values.quantity)!;
    if (returning > outstanding) {
      form.setError("quantity", {
        message: `Only ${outstanding} still on the hive`,
      });
      return;
    }
    mutation.mutate(
      {
        deploymentId: deployment.id,
        quantity: returning,
        reason: values.reason,
        condition: values.condition,
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
          <DialogTitle>Return {deployment.typeName}</DialogTitle>
          <DialogDescription>
            {outstanding} of {deployment.quantity} still on{" "}
            {deployment.hiveLabel}.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="return-quantity">Quantity</Label>
              <Input
                id="return-quantity"
                type="number"
                inputMode="numeric"
                step={1}
                min={1}
                max={outstanding}
                {...form.register("quantity")}
              />
              <FieldError message={errors.quantity?.message} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="return-date">Date</Label>
              <Input id="return-date" type="date" {...form.register("date")} />
              <FieldError message={errors.date?.message} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="return-reason">Reason</Label>
            <Select
              value={form.watch("reason")}
              onValueChange={(value) =>
                form.setValue("reason", value, { shouldValidate: true })
              }
            >
              <SelectTrigger id="return-reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RETURN_REASONS.map((reason) => (
                  <SelectItem key={reason} value={reason}>
                    {reasonLabel(reason)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={errors.reason?.message} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="return-condition">Condition</Label>
            <Select
              value={form.watch("condition")}
              onValueChange={(value) =>
                form.setValue("condition", value, { shouldValidate: true })
              }
            >
              <SelectTrigger id="return-condition">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RETURN_CONDITIONS.map((condition: ReturnCondition) => (
                  <SelectItem key={condition} value={condition}>
                    {CONDITION_LABELS[condition]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={errors.condition?.message} />
          </div>
          {quantity > 0 && quantity < outstanding && (
            <p className="rounded-lg border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              {outstanding - quantity} will stay on {deployment.hiveLabel}.
            </p>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="return-notes">Notes</Label>
            <Textarea
              id="return-notes"
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
              {mutation.isPending ? "Returning…" : "Return"}
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
