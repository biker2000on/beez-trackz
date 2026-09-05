"use client";

/**
 * Quick-action dialogs for the honey ledger: Jar Honey, Bulk Use / Loss,
 * Give Away, and Adjust Jars. Record Sale lives in record-sale-dialog.tsx.
 */

import * as React from "react";
import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
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
import { ShortcutForm } from "@/components/ui/shortcut-form";
import { Textarea } from "@/components/ui/textarea";

import { useHarvestLots } from "@/features/commerce/api";
import { useUnits } from "@/lib/use-units";

import { parseHoneyWeight, parseNum, todayISO } from "./format";
import {
  useAdjustJars,
  useHoneyLotBalances,
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

// --- lot picker ---
//
// Bulk honey is tracked per harvest lot, so every draw — jarring, bulk use, a
// loss — has to name the lot it came out of. There is no untraced escape
// hatch: without a lot the API refuses the movement.

/** The lots to choose from and how much bulk each still holds. */
function useLotChoices(open: boolean) {
  const lots = useHarvestLots(open);
  const balances = useHoneyLotBalances(open);
  const remainingByLot = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const row of balances.data?.lots ?? []) map.set(row.lotId, row.onHandLbs);
    return map;
  }, [balances.data]);
  return {
    list: lots.data ?? [],
    remainingByLot,
    isPending: lots.isPending,
  };
}

function LotField({
  id,
  value,
  onChange,
  lots,
  remainingByLot,
  loading,
  remaining,
  error,
  onNavigate,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  lots: ReturnType<typeof useLotChoices>["list"];
  /** Bulk pounds left per lot; lots with nothing left are not offered. */
  remainingByLot: Map<string, number>;
  loading: boolean;
  remaining: number | undefined;
  error?: string;
  /** Closes the dialog when the operator leaves to create a lot. */
  onNavigate: () => void;
}) {
  const { formatHoney } = useUnits();
  // Only lots that still hold bulk honey are worth choosing; the one already
  // chosen stays listed so an edit never loses its value.
  const choices = lots.filter(
    (lot) => lot.id === value || (remainingByLot.get(lot.id) ?? 0) > 0,
  );
  if (lots.length === 0 && !loading) {
    return (
      <div className="grid gap-1.5">
        <Label>Honey lot</Label>
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          Bulk honey is tracked per harvest lot, so there is nothing to draw
          from yet.{" "}
          <Link
            href="/production/lots"
            onClick={onNavigate}
            className="font-medium text-primary hover:underline"
          >
            Create a harvest lot
          </Link>{" "}
          first.
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Honey lot</Label>
      <Select value={value} onValueChange={onChange} disabled={loading}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={loading ? "Loading…" : "Choose a lot"} />
        </SelectTrigger>
        <SelectContent>
          {choices.map((lot) => (
            <SelectItem key={lot.id} value={lot.id}>
              {lot.lotCode}
              {lot.varietalName ? ` · ${lot.varietalName}` : ""}
              {remainingByLot.has(lot.id)
                ? ` · ${formatHoney(remainingByLot.get(lot.id) ?? 0)} left`
                : ""}
            </SelectItem>
          ))}
          {choices.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No lot has bulk honey left.
            </div>
          )}
        </SelectContent>
      </Select>
      {remaining != null && (
        <p className="text-xs text-muted-foreground">
          {formatHoney(remaining)} left in{" "}
          {lots.find((lot) => lot.id === value)?.lotCode}
        </p>
      )}
      <FieldError message={error} />
    </div>
  );
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
  const lots = useLotChoices(open);
  const form = useForm<JarringValues>({
    resolver: zodResolver(jarringSchema),
    defaultValues: { date: todayISO(), lossLbs: "", lossReason: "", notes: "" },
  });
  const [lines, setLines] = React.useState<JarLineValue[]>([]);
  const [lineError, setLineError] = React.useState<string | null>(null);
  const [lotId, setLotId] = React.useState("");
  const [lotError, setLotError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    form.reset({ date: todayISO(), lossLbs: "", lossReason: "", notes: "" });
    // Each opening is a new transaction draft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLines(makeJarLines(inventory));
    setLineError(null);
    setLotId("");
    setLotError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inventory]);

  const selectedLot = lots.list.find((lot) => lot.id === lotId);
  const remaining = lotId ? lots.remainingByLot.get(lotId) : undefined;

  const totals = lines.reduce(
    (acc, line) => {
      const row = inventory.find((r) => r.jarSizeId === line.jarSizeId);
      const qty = parseNum(line.quantity) ?? 0;
      if (qty > 0) {
        acc.jars += qty;
        acc.oz += row?.honeyOz ? row.honeyOz * qty : 0;
      }
      return acc;
    },
    { jars: 0, oz: 0 },
  );
  const estimatedLbs = totals.oz / 16;
  // A warning, never a block: the jars are already filled, so the honest
  // record is the entry plus a nudge to check the lot's numbers.
  const overdrawn =
    remaining != null && estimatedLbs > remaining ? remaining : null;

  const submitJarring = (resetAfter: boolean) => form.handleSubmit((values) => {
    if (lotId === "") {
      setLotError("Choose the honey lot these jars were filled from");
      return;
    }
    setLotError(null);
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
        lotId,
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
        onSuccess: (result) => {
          const warnings = result?.packagingWarnings ?? [];
          if (warnings.length > 0) {
            toast.warning("Empty containers ran short", {
              description: warnings.join(" · "),
            });
          }
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
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="jarring-date">Date</Label>
              <Input id="jarring-date" type="date" {...form.register("date")} />
              <FieldError message={errors.date?.message} />
            </div>
            <LotField
              id="jarring-lot"
              value={lotId}
              onChange={(value) => {
                setLotId(value);
                setLotError(null);
              }}
              lots={lots.list}
              remainingByLot={lots.remainingByLot}
              loading={lots.isPending}
              remaining={remaining}
              error={lotError ?? undefined}
              onNavigate={() => onOpenChange(false)}
            />
          </div>
          {selectedLot && (
            <p className="text-xs text-muted-foreground">
              These jars are recorded as a bottling run of {selectedLot.lotCode}
              {selectedLot.varietalName ? ` (${selectedLot.varietalName})` : ""},
              so the lot follows them to serials and sales.
            </p>
          )}
          <div className="grid gap-1.5">
            <JarLinesEditor rows={inventory} value={lines} onChange={setLines} />
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {totals.jars} {totals.jars === 1 ? "jar" : "jars"} ·{" "}
              {Math.round(totals.oz * 10) / 10} oz ≈ {formatHoney(estimatedLbs)} of bulk honey
              {remaining != null && estimatedLbs <= remaining
                ? ` · leaves ${formatHoney(remaining - estimatedLbs)} in ${selectedLot?.lotCode ?? "the lot"}`
                : ""}
            </p>
            {overdrawn != null && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                That is more than the {formatHoney(overdrawn)} left in{" "}
                {selectedLot?.lotCode}. Saved anyway — check the lot&rsquo;s
                extracted weight if this looks wrong.
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
            <Button
              type="submit"
              disabled={
                mutation.isPending || (!lots.isPending && lots.list.length === 0)
              }
            >
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
  const { formatHoney, units, honeySuffix } = useUnits();
  const mutation = useRecordBulkMovement();
  const lots = useLotChoices(open);
  const form = useForm<BulkValues>({
    resolver: zodResolver(bulkSchema),
    defaultValues: { date: todayISO(), amountLbs: "", reason: "", notes: "" },
  });
  const [lotId, setLotId] = React.useState("");
  const [lotError, setLotError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    form.reset({ date: todayISO(), amountLbs: "", reason: "", notes: "" });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLotId("");
    setLotError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const remaining = lotId ? lots.remainingByLot.get(lotId) : undefined;
  const enteredAmount = useWatch({ control: form.control, name: "amountLbs" });
  const enteredLbs = parseHoneyWeight(enteredAmount ?? "", units);
  const overdrawn =
    remaining != null && enteredLbs != null && enteredLbs > remaining
      ? remaining
      : null;

  const isLoss = kind === "loss";
  const submitMovement = (resetAfter: boolean) => form.handleSubmit((values) => {
    if (lotId === "") {
      setLotError("Choose the honey lot this came out of");
      return;
    }
    setLotError(null);
    const amountLbs = parseHoneyWeight(values.amountLbs, units);
    if (amountLbs == null || amountLbs <= 0) {
      form.setError("amountLbs", { message: "Enter an amount greater than zero" });
      return;
    }
    mutation.mutate(
      {
        date: values.date,
        kind,
        lotId,
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
          <LotField
            id={`${idPrefix}-lot`}
            value={lotId}
            onChange={(value) => {
              setLotId(value);
              setLotError(null);
            }}
            lots={lots.list}
            remainingByLot={lots.remainingByLot}
            loading={lots.isPending}
            remaining={remaining}
            error={lotError ?? undefined}
            onNavigate={() => onOpenChange(false)}
          />
          {enteredLbs != null && enteredLbs > 0 && remaining != null && (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {isLoss ? "Losing" : "Using"} {formatHoney(enteredLbs)}
              {overdrawn == null
                ? ` leaves ${formatHoney(remaining - enteredLbs)} in ${
                    lots.list.find((lot) => lot.id === lotId)?.lotCode ?? "the lot"
                  }`
                : ""}
            </p>
          )}
          {overdrawn != null && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              That is more than the {formatHoney(overdrawn)} that lot still
              holds. Saved anyway — check the lot&rsquo;s numbers if this looks
              wrong.
            </p>
          )}
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
            <Button
              type="submit"
              disabled={
                mutation.isPending || (!lots.isPending && lots.list.length === 0)
              }
            >
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

  const giveTotals = lines.reduce(
    (acc, line) => {
      const row = inventory.find((r) => r.jarSizeId === line.jarSizeId);
      const qty = parseNum(line.quantity) ?? 0;
      if (qty > 0) {
        acc.jars += qty;
        acc.oz += row?.honeyOz ? row.honeyOz * qty : 0;
      }
      return acc;
    },
    { jars: 0, oz: 0 },
  );
  // Sizes asked for beyond what is on hand. A warning, not a block: the API
  // is the one that refuses, and it says so inline.
  const giveOver = lines.flatMap((line) => {
    const row = inventory.find((r) => r.jarSizeId === line.jarSizeId);
    const qty = parseNum(line.quantity) ?? 0;
    return row && qty > row.onHand ? [row.label] : [];
  });

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
              hideEmpty
              warnOverdraw
            />
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {giveTotals.jars} {giveTotals.jars === 1 ? "jar" : "jars"} ·{" "}
              {Math.round(giveTotals.oz * 10) / 10} oz
            </p>
            {giveOver.length > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                More {giveOver.join(", ")} than on hand — the ledger will refuse
                this unless the counts are corrected first.
              </p>
            )}
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

  // "Pint 12 → 9": the counts this entry leaves behind, one per touched size.
  const adjustSummary = lines.flatMap((line) => {
    const row = inventory.find((r) => r.jarSizeId === line.jarSizeId);
    const delta = parseNum(line.quantity) ?? 0;
    return row && delta !== 0
      ? [`${row.label} ${row.onHand} → ${row.onHand + delta}`]
      : [];
  });

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
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {adjustSummary.length > 0
                ? adjustSummary.join(" · ")
                : "No counts change yet."}
            </p>
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
