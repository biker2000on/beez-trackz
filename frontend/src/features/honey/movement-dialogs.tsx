"use client";

/**
 * Quick-action dialogs for the honey ledger: Jar Honey, Bulk Use / Loss,
 * Give Away, and Adjust Jars. Record Sale lives in record-sale-dialog.tsx.
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
import { ShortcutForm } from "@/components/ui/shortcut-form";
import { Textarea } from "@/components/ui/textarea";

import { useUnits } from "@/lib/use-units";

import { parseHoneyWeight, parseNum, todayISO } from "./format";
import {
  useAdjustJars,
  useRecordBulkMovement,
  useRecordGiveAway,
  useRecordJarring,
} from "./hooks";
import {
  JarLinesEditor,
  makeJarLines,
  type JarLineValue,
} from "./jar-lines-editor";
import type { HoneyInventoryRow } from "./types";

interface QuickDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inventory: HoneyInventoryRow[];
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

// --- Jar Honey (j) ---

const jarringSchema = z.object({
  date: z.string().min(1, "Date is required"),
  lossLbs: z.string(),
  lossReason: z.string(),
  notes: z.string(),
});
type JarringValues = z.infer<typeof jarringSchema>;

export function JarHoneyDialog({
  open,
  onOpenChange,
  inventory,
}: QuickDialogProps) {
  const { formatHoney, units, honeySuffix } = useUnits();
  const mutation = useRecordJarring();
  const form = useForm<JarringValues>({
    resolver: zodResolver(jarringSchema),
    defaultValues: { date: todayISO(), lossLbs: "", lossReason: "", notes: "" },
  });
  const [lines, setLines] = React.useState<JarLineValue[]>([]);
  const [lineError, setLineError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    form.reset({ date: todayISO(), lossLbs: "", lossReason: "", notes: "" });
    // Each opening is a new transaction draft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLines(makeJarLines(inventory));
    setLineError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inventory]);

  const estimatedLbs = lines.reduce((sum, line) => {
    const row = inventory.find((r) => r.jarSizeId === line.jarSizeId);
    const qty = parseNum(line.quantity) ?? 0;
    return sum + (row?.honeyOz && qty > 0 ? (row.honeyOz * qty) / 16 : 0);
  }, 0);

  const submitJarring = (resetAfter: boolean) => form.handleSubmit((values) => {
    const jarLines = lines
      .map((line) => ({
        jarSizeId: line.jarSizeId,
        quantity: parseNum(line.quantity) ?? 0,
      }))
      .filter((line) => line.quantity > 0);
    const lossLbs = parseHoneyWeight(values.lossLbs, units);
    const hasLoss = lossLbs != null && lossLbs > 0;
    if (jarLines.length === 0 && !hasLoss) {
      setLineError("Add at least one jar or a loss amount.");
      return;
    }
    setLineError(null);
    mutation.mutate(
      {
        date: values.date,
        lines: jarLines,
        ...(hasLoss
          ? {
              lossLbs,
              lossReason: values.lossReason.trim() || undefined,
            }
          : {}),
        notes: values.notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          if (resetAfter) {
            form.reset({ date: todayISO(), lossLbs: "", lossReason: "", notes: "" });
            setLines(makeJarLines(inventory));
          } else onOpenChange(false);
        },
      },
    );
  });
  const onSubmit = submitJarring(false);

  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Jar honey</DialogTitle>
          <DialogDescription>
            Record jars filled from your bulk honey.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          onSubmit={onSubmit}
          onSubmitAndReset={submitJarring(true)}
          onEscape={() => onOpenChange(false)}
          className="grid gap-4"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="jarring-date">Date</Label>
            <Input id="jarring-date" type="date" {...form.register("date")} />
            <FieldError message={errors.date?.message} />
          </div>
          <div className="grid gap-1.5">
            <JarLinesEditor rows={inventory} value={lines} onChange={setLines} />
            {estimatedLbs > 0 && (
              <p className="text-xs text-muted-foreground">
                ≈ {formatHoney(estimatedLbs)} of bulk honey
              </p>
            )}
            <FieldError message={lineError ?? undefined} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="jarring-loss">Loss ({honeySuffix}, optional)</Label>
              <Input
                id="jarring-loss"
                inputMode="decimal"
                placeholder={`0 ${honeySuffix}`}
                {...form.register("lossLbs")}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="jarring-loss-reason">Loss reason</Label>
              <Input
                id="jarring-loss-reason"
                placeholder="jarring loss"
                {...form.register("lossReason")}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="jarring-notes">Notes</Label>
            <Textarea
              id="jarring-notes"
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
              {mutation.isPending ? "Saving…" : "Record jarring"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// --- Bulk Use (u) / Loss (l) ---

const bulkSchema = z.object({
  date: z.string().min(1, "Date is required"),
  amountLbs: z.string().trim().min(1, "Enter an amount"),
  reason: z.string(),
  notes: z.string(),
});
type BulkValues = z.infer<typeof bulkSchema>;

export function BulkMovementDialog({
  open,
  onOpenChange,
  kind,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "bulk_use" | "loss";
}) {
  const { units, honeySuffix } = useUnits();
  const mutation = useRecordBulkMovement();
  const form = useForm<BulkValues>({
    resolver: zodResolver(bulkSchema),
    defaultValues: { date: todayISO(), amountLbs: "", reason: "", notes: "" },
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset({ date: todayISO(), amountLbs: "", reason: "", notes: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isLoss = kind === "loss";
  const submitMovement = (resetAfter: boolean) => form.handleSubmit((values) => {
    const amountLbs = parseHoneyWeight(values.amountLbs, units);
    if (amountLbs == null || amountLbs <= 0) {
      form.setError("amountLbs", { message: "Enter an amount greater than zero" });
      return;
    }
    mutation.mutate(
      {
        date: values.date,
        kind,
        amountLbs,
        reason: values.reason.trim() || undefined,
        notes: values.notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          if (resetAfter) form.reset({ date: todayISO(), amountLbs: "", reason: "", notes: "" });
          else onOpenChange(false);
        },
      },
    );
  });
  const onSubmit = submitMovement(false);

  const { errors } = form.formState;
  const idPrefix = isLoss ? "loss" : "bulk-use";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isLoss ? "Record a loss" : "Use bulk honey"}</DialogTitle>
          <DialogDescription>
            {isLoss
              ? "Record bulk honey lost to spills, fermentation, or waste."
              : "Record bulk honey used for cooking, mead, gifts in bulk, and so on."}
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          onSubmit={onSubmit}
          onSubmitAndReset={submitMovement(true)}
          onEscape={() => onOpenChange(false)}
          className="grid gap-4"
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`${idPrefix}-date`}>Date</Label>
              <Input
                id={`${idPrefix}-date`}
                type="date"
                {...form.register("date")}
              />
              <FieldError message={errors.date?.message} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${idPrefix}-amount`}>Amount ({honeySuffix})</Label>
              <Input
                id={`${idPrefix}-amount`}
                inputMode="decimal"
                placeholder={`e.g. 2 kg or 4.4 ${honeySuffix}`}
                {...form.register("amountLbs")}
              />
              <FieldError message={errors.amountLbs?.message} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${idPrefix}-reason`}>Reason</Label>
            <Input
              id={`${idPrefix}-reason`}
              placeholder={isLoss ? "e.g. fermented, spilled" : "e.g. mead batch"}
              {...form.register("reason")}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${idPrefix}-notes`}>Notes</Label>
            <Textarea
              id={`${idPrefix}-notes`}
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
              {mutation.isPending
                ? "Saving…"
                : isLoss
                  ? "Record loss"
                  : "Record use"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// --- Give Away (v) ---

const giveAwaySchema = z.object({
  date: z.string().min(1, "Date is required"),
  reason: z.string(),
  notes: z.string(),
});
type GiveAwayValues = z.infer<typeof giveAwaySchema>;

export function GiveAwayDialog({
  open,
  onOpenChange,
  inventory,
}: QuickDialogProps) {
  const mutation = useRecordGiveAway();
  const form = useForm<GiveAwayValues>({
    resolver: zodResolver(giveAwaySchema),
    defaultValues: { date: todayISO(), reason: "", notes: "" },
  });
  const [lines, setLines] = React.useState<JarLineValue[]>([]);
  const [lineError, setLineError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    form.reset({ date: todayISO(), reason: "", notes: "" });
    // Each opening is a new transaction draft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLines(makeJarLines(inventory));
    setLineError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inventory]);

  const submitGiveAway = (resetAfter: boolean) => form.handleSubmit((values) => {
    const jarLines = lines
      .map((line) => ({
        jarSizeId: line.jarSizeId,
        quantity: parseNum(line.quantity) ?? 0,
      }))
      .filter((line) => line.quantity > 0);
    if (jarLines.length === 0) {
      setLineError("Add at least one jar.");
      return;
    }
    setLineError(null);
    mutation.mutate(
      {
        date: values.date,
        lines: jarLines,
        reason: values.reason.trim() || undefined,
        notes: values.notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          if (resetAfter) {
            form.reset({ date: todayISO(), reason: "", notes: "" });
            setLines(makeJarLines(inventory));
          } else onOpenChange(false);
        },
      },
    );
  });
  const onSubmit = submitGiveAway(false);

  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Give away jars</DialogTitle>
          <DialogDescription>
            Record jars given away as gifts or samples.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          onSubmit={onSubmit}
          onSubmitAndReset={submitGiveAway(true)}
          onEscape={() => onOpenChange(false)}
          className="grid gap-4"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="give-date">Date</Label>
            <Input id="give-date" type="date" {...form.register("date")} />
            <FieldError message={errors.date?.message} />
          </div>
          <div className="grid gap-1.5">
            <JarLinesEditor
              rows={inventory}
              value={lines}
              onChange={setLines}
              showOnHand
            />
            <FieldError message={lineError ?? undefined} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="give-reason">Recipient / reason</Label>
            <Input
              id="give-reason"
              placeholder="e.g. neighbors, farmers market samples"
              {...form.register("reason")}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="give-notes">Notes</Label>
            <Textarea
              id="give-notes"
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
              {mutation.isPending ? "Saving…" : "Record give-away"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// --- Adjust Jars (a) ---

const adjustSchema = z.object({
  date: z.string().min(1, "Date is required"),
  reason: z.string(),
});
type AdjustValues = z.infer<typeof adjustSchema>;

export function AdjustJarsDialog({
  open,
  onOpenChange,
  inventory,
}: QuickDialogProps) {
  const mutation = useAdjustJars();
  const form = useForm<AdjustValues>({
    resolver: zodResolver(adjustSchema),
    defaultValues: { date: todayISO(), reason: "" },
  });
  const [lines, setLines] = React.useState<JarLineValue[]>([]);
  const [lineError, setLineError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    form.reset({ date: todayISO(), reason: "" });
    // Each opening is a new transaction draft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLines(makeJarLines(inventory));
    setLineError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inventory]);

  const submitAdjustment = (resetAfter: boolean) => form.handleSubmit((values) => {
    const deltas = lines
      .map((line) => ({
        jarSizeId: line.jarSizeId,
        delta: parseNum(line.quantity) ?? 0,
      }))
      .filter((line) => Number.isInteger(line.delta) && line.delta !== 0);
    if (deltas.length === 0) {
      setLineError("Enter at least one non-zero adjustment.");
      return;
    }
    setLineError(null);
    mutation.mutate(
      {
        date: values.date,
        lines: deltas,
        reason: values.reason.trim() || undefined,
      },
      {
        onSuccess: () => {
          if (resetAfter) {
            form.reset({ date: todayISO(), reason: "" });
            setLines(makeJarLines(inventory));
          } else onOpenChange(false);
        },
      },
    );
  });
  const onSubmit = submitAdjustment(false);

  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust jar counts</DialogTitle>
          <DialogDescription>
            Correct on-hand counts with a positive or negative delta per size.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          onSubmit={onSubmit}
          onSubmitAndReset={submitAdjustment(true)}
          onEscape={() => onOpenChange(false)}
          className="grid gap-4"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="adjust-date">Date</Label>
            <Input id="adjust-date" type="date" {...form.register("date")} />
            <FieldError message={errors.date?.message} />
          </div>
          <div className="grid gap-1.5">
            <JarLinesEditor
              rows={inventory}
              value={lines}
              onChange={setLines}
              showOnHand
              allowNegative
              showNewTotal
            />
            <FieldError message={lineError ?? undefined} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="adjust-reason">Reason</Label>
            <Input
              id="adjust-reason"
              placeholder="manual correction"
              {...form.register("reason")}
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
              {mutation.isPending ? "Saving…" : "Apply adjustments"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}
