"use client";

/**
 * Per-row ledger dialogs. Every one of them writes an entry that says what
 * happened and why — receive, deploy, adjust, mark damaged, repair, retire —
 * instead of editing a quantity in place. Plus the stock detail editor
 * (location, needed, unit cost) and the combined history viewer.
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
import { ShortcutForm } from "@/components/ui/shortcut-form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

import { formatCents, formatDate, parseCents, parseNum, todayISO } from "./format";
import {
  useAdjustStock,
  useDeployEquipment,
  useEquipmentStock,
  useHiveOptions,
  useMarkDamaged,
  useReceiveStock,
  useRepairStock,
  useRetireStock,
  useStockAdjustments,
  useStockStateChanges,
  useUpdateStock,
} from "./hooks";
import {
  ADJUSTMENT_REASONS,
  RECEIVE_REASONS,
  STATE_REASONS,
  reasonLabel,
  type EquipmentStockRow,
} from "./types";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

interface StockDialogProps {
  stock: EquipmentStockRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Which pile a removal or state change draws from. */
type StockPool = "serviceable" | "damaged" | "retired";

/** Reason picker shared by every ledger dialog. */
function ReasonSelect({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Choose a reason" />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {reasonLabel(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const wholeNumber = (min: number, message: string) =>
  z
    .string()
    .refine(
      (v) => Number.isInteger(parseNum(v) ?? NaN) && (parseNum(v) ?? -1) >= min,
      message,
    );

// --- deploy to hive ---

const deploySchema = z.object({
  hiveId: z.string(),
  stockId: z.string(),
  quantity: wholeNumber(1, "Quantity must be at least 1"),
  notes: z.string(),
});
type DeployValues = z.infer<typeof deploySchema>;

/**
 * The one deploy dialog. From the inventory table the stock row is fixed and
 * the hive is chosen; from a hive's Equipment tab the hive is fixed and the
 * stock row is chosen. Both directions used to be independent
 * implementations with different validation.
 */
export function DeployDialog({
  stock,
  hiveId,
  open,
  onOpenChange,
}: {
  stock?: EquipmentStockRow;
  hiveId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const hives = useHiveOptions();
  const stockRows = useEquipmentStock();
  const mutation = useDeployEquipment();
  const form = useForm<DeployValues>({
    resolver: zodResolver(deploySchema),
    defaultValues: {
      hiveId: hiveId ?? "",
      stockId: stock?.id ?? "",
      quantity: "1",
      notes: "",
    },
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset({
      hiveId: hiveId ?? "",
      stockId: stock?.id ?? "",
      quantity: "1",
      notes: "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const availableStock = (stockRows.data ?? []).filter(
    (row) => row.available > 0,
  );
  const selectedStock =
    stock ??
    availableStock.find((row) => row.id === form.watch("stockId"));

  const resetDeploy = () => form.reset({
    hiveId: hiveId ?? "",
    stockId: stock?.id ?? "",
    quantity: "1",
    notes: "",
  });
  const submitDeploy = (resetAfter: boolean) => form.handleSubmit((values) => {
    if (!values.hiveId) {
      form.setError("hiveId", { message: "Hive is required" });
      return;
    }
    if (!values.stockId) {
      form.setError("stockId", { message: "Choose equipment to deploy" });
      return;
    }
    const quantity = parseNum(values.quantity)!;
    const available = selectedStock?.available ?? 0;
    if (quantity > available) {
      form.setError("quantity", { message: `Only ${available} available` });
      return;
    }
    mutation.mutate(
      {
        stockId: values.stockId,
        hiveId: values.hiveId,
        quantity,
        notes: values.notes.trim() || undefined,
      },
      { onSuccess: () => resetAfter ? resetDeploy() : onOpenChange(false) },
    );
  });
  const onSubmit = submitDeploy(false);

  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {stock ? `Deploy ${stock.typeName}` : "Deploy equipment"}
          </DialogTitle>
          <DialogDescription>
            {stock
              ? `${stock.available} in storage available to deploy.`
              : "Move equipment from storage onto this hive."}
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          onSubmit={onSubmit}
          onSubmitAndReset={submitDeploy(true)}
          onEscape={() => onOpenChange(false)}
          className="grid gap-4"
        >
          {!stock && (
            <div className="grid gap-1.5">
              <Label>Equipment</Label>
              <Select
                value={form.watch("stockId")}
                onValueChange={(value) =>
                  form.setValue("stockId", value, { shouldValidate: true })
                }
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      stockRows.isPending
                        ? "Loading…"
                        : availableStock.length === 0
                          ? "Nothing available in storage"
                          : "Select equipment"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {availableStock.map((row) => (
                    <SelectItem key={row.id} value={row.id}>
                      {row.typeName}
                      {row.frameCondition ? ` (${row.frameCondition})` : ""} —{" "}
                      {row.available} available
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={errors.stockId?.message} />
            </div>
          )}
          {!hiveId && (
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
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="deploy-quantity">Quantity</Label>
            <Input
              id="deploy-quantity"
              type="number"
              inputMode="numeric"
              step={1}
              min={1}
              max={selectedStock?.available ?? undefined}
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
              disabled={
                mutation.isPending || (selectedStock?.available ?? 0) < 1
              }
            >
              {mutation.isPending ? "Deploying…" : "Deploy"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// --- receive ---

const receiveSchema = z.object({
  quantity: wholeNumber(1, "Quantity must be at least 1"),
  reason: z.string().min(1, "Reason is required"),
  unitCost: z.string(),
  date: z.string().min(1, "Date is required"),
  notes: z.string(),
});
type ReceiveValues = z.infer<typeof receiveSchema>;

export function ReceiveDialog({ stock, open, onOpenChange }: StockDialogProps) {
  const mutation = useReceiveStock();
  const defaults = React.useMemo<ReceiveValues>(
    () => ({
      quantity: "1",
      reason: "purchased",
      unitCost:
        stock.unitCostCents != null ? String(stock.unitCostCents / 100) : "",
      date: todayISO(),
      notes: "",
    }),
    [stock.unitCostCents],
  );
  const form = useForm<ReceiveValues>({
    resolver: zodResolver(receiveSchema),
    defaultValues: defaults,
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset(defaults);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaults]);

  const submitReceive = (resetAfter: boolean) => form.handleSubmit((values) => {
    const unitCostCents = parseCents(values.unitCost);
    if (values.unitCost.trim() !== "" && unitCostCents == null) {
      form.setError("unitCost", { message: "Enter an amount like 24.50" });
      return;
    }
    mutation.mutate(
      {
        stockId: stock.id,
        quantity: parseNum(values.quantity)!,
        reason: values.reason,
        unitCostCents: unitCostCents ?? undefined,
        date: values.date,
        notes: values.notes.trim() || undefined,
      },
      { onSuccess: () => resetAfter ? form.reset(defaults) : onOpenChange(false) },
    );
  });
  const onSubmit = submitReceive(false);

  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Receive {stock.typeName}</DialogTitle>
          <DialogDescription>
            Add newly bought or built equipment to stock. {stock.totalOwned}{" "}
            owned today.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          onSubmit={onSubmit}
          onSubmitAndReset={submitReceive(true)}
          onEscape={() => onOpenChange(false)}
          className="grid gap-4"
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="receive-quantity">Quantity</Label>
              <Input
                id="receive-quantity"
                type="number"
                inputMode="numeric"
                step={1}
                min={1}
                {...form.register("quantity")}
              />
              <FieldError message={errors.quantity?.message} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="receive-reason">Reason</Label>
              <ReasonSelect
                id="receive-reason"
                value={form.watch("reason")}
                options={RECEIVE_REASONS}
                onChange={(value) =>
                  form.setValue("reason", value, { shouldValidate: true })
                }
              />
              <FieldError message={errors.reason?.message} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="receive-cost">Unit cost</Label>
              <Input
                id="receive-cost"
                inputMode="decimal"
                placeholder="e.g. 24.50"
                {...form.register("unitCost")}
              />
              <FieldError message={errors.unitCost?.message} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="receive-date">Date</Label>
              <Input id="receive-date" type="date" {...form.register("date")} />
              <FieldError message={errors.date?.message} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="receive-notes">Notes</Label>
            <Textarea
              id="receive-notes"
              rows={2}
              placeholder="Supplier, order number, …"
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
              {mutation.isPending ? "Saving…" : "Receive"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
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
  from: z.string(),
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
      from: "serviceable",
      date: todayISO(),
      notes: "",
    },
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset({
      quantity: "",
      reason: "purchased",
      from: "serviceable",
      date: todayISO(),
      notes: "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const delta = parseNum(form.watch("quantity")) ?? 0;
  const from = form.watch("from");
  const pool =
    from === "damaged"
      ? stock.damaged
      : from === "retired"
        ? stock.retired
        : stock.available;

  const resetAdjustment = () => form.reset({
    quantity: "",
    reason: "purchased",
    from: "serviceable",
    date: todayISO(),
    notes: "",
  });
  const submitAdjustment = (resetAfter: boolean) => form.handleSubmit((values) => {
    const quantity = parseNum(values.quantity)!;
    if (quantity < 0 && -quantity > pool) {
      form.setError("quantity", { message: `Only ${pool} to remove` });
      return;
    }
    mutation.mutate(
      {
        stockId: stock.id,
        quantity,
        reason: values.reason,
        from: quantity < 0 ? (values.from as StockPool) : undefined,
        date: values.date,
        notes: values.notes.trim() || undefined,
      },
      { onSuccess: () => resetAfter ? resetAdjustment() : onOpenChange(false) },
    );
  });
  const onSubmit = submitAdjustment(false);

  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust {stock.typeName}</DialogTitle>
          <DialogDescription>
            Correct what you own outside the normal flow. {stock.totalOwned}{" "}
            owned, {stock.available} available.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          onSubmit={onSubmit}
          onSubmitAndReset={submitAdjustment(true)}
          onEscape={() => onOpenChange(false)}
          className="grid gap-4"
        >
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
              <Label htmlFor="adjust-reason">Reason</Label>
              <ReasonSelect
                id="adjust-reason"
                value={form.watch("reason")}
                options={ADJUSTMENT_REASONS}
                onChange={(value) =>
                  form.setValue("reason", value, { shouldValidate: true })
                }
              />
              <FieldError message={errors.reason?.message} />
            </div>
          </div>
          {delta < 0 && (
            <div className="grid gap-1.5">
              <Label htmlFor="adjust-from">Remove from</Label>
              <Select
                value={from}
                onValueChange={(value) => form.setValue("from", value)}
              >
                <SelectTrigger id="adjust-from">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="serviceable">
                    In storage ({stock.available})
                  </SelectItem>
                  <SelectItem value="damaged">
                    Damaged ({stock.damaged})
                  </SelectItem>
                  <SelectItem value="retired">
                    Retired ({stock.retired})
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Disposing of damaged or retired gear clears it from that pile
                too.
              </p>
            </div>
          )}
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
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// --- condition states: damaged / repaired / retired ---

export type StateDialogMode = "damage" | "repair" | "retire";

const stateSchema = z.object({
  quantity: wholeNumber(1, "Quantity must be at least 1"),
  reason: z.string().min(1, "Reason is required"),
  from: z.string(),
  date: z.string().min(1, "Date is required"),
  notes: z.string(),
});
type StateValues = z.infer<typeof stateSchema>;

const STATE_COPY: Record<
  StateDialogMode,
  { title: string; description: string; action: string; reason: string }
> = {
  damage: {
    title: "Mark damaged",
    description:
      "Damaged equipment stays on the books but stops counting as available.",
    action: "Mark damaged",
    reason: "broken",
  },
  repair: {
    title: "Back in service",
    description: "Move repaired equipment out of the damaged pile.",
    action: "Return to service",
    reason: "repaired",
  },
  retire: {
    title: "Retire",
    description:
      "Retired equipment is still owned but permanently out of service.",
    action: "Retire",
    reason: "worn_out",
  },
};

export function StateChangeDialog({
  stock,
  mode,
  open,
  onOpenChange,
}: StockDialogProps & { mode: StateDialogMode }) {
  const damage = useMarkDamaged();
  const repair = useRepairStock();
  const retire = useRetireStock();
  const mutation =
    mode === "damage" ? damage : mode === "repair" ? repair : retire;
  const copy = STATE_COPY[mode];

  const defaultFrom = mode === "repair" ? "damaged" : "serviceable";
  const form = useForm<StateValues>({
    resolver: zodResolver(stateSchema),
    defaultValues: {
      quantity: "1",
      reason: copy.reason,
      from: defaultFrom,
      date: todayISO(),
      notes: "",
    },
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset({
      quantity: "1",
      reason: copy.reason,
      from: defaultFrom,
      date: todayISO(),
      notes: "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  const from = form.watch("from");
  const pool =
    from === "damaged"
      ? stock.damaged
      : from === "retired"
        ? stock.retired
        : stock.available;

  const resetState = () => form.reset({
    quantity: "1",
    reason: copy.reason,
    from: defaultFrom,
    date: todayISO(),
    notes: "",
  });
  const submitState = (resetAfter: boolean) => form.handleSubmit((values) => {
    const quantity = parseNum(values.quantity)!;
    if (quantity > pool) {
      form.setError("quantity", { message: `Only ${pool} to move` });
      return;
    }
    mutation.mutate(
      {
        stockId: stock.id,
        quantity,
        reason: values.reason,
        from: values.from as StockPool,
        date: values.date,
        notes: values.notes.trim() || undefined,
      },
      { onSuccess: () => resetAfter ? resetState() : onOpenChange(false) },
    );
  });
  const onSubmit = submitState(false);

  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {copy.title} — {stock.typeName}
          </DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <ShortcutForm
          onSubmit={onSubmit}
          onSubmitAndReset={submitState(true)}
          onEscape={() => onOpenChange(false)}
          className="grid gap-4"
        >
          {mode === "retire" && (
            <div className="grid gap-1.5">
              <Label htmlFor="state-from">Retire from</Label>
              <Select
                value={from}
                onValueChange={(value) => form.setValue("from", value)}
              >
                <SelectTrigger id="state-from">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="serviceable">
                    In storage ({stock.available})
                  </SelectItem>
                  <SelectItem value="damaged">
                    Damaged ({stock.damaged})
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="state-quantity">Quantity</Label>
              <Input
                id="state-quantity"
                type="number"
                inputMode="numeric"
                step={1}
                min={1}
                max={pool}
                {...form.register("quantity")}
              />
              <FieldError message={errors.quantity?.message} />
              <p className="text-xs text-muted-foreground">
                {pool} available to move.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="state-reason">Reason</Label>
              <ReasonSelect
                id="state-reason"
                value={form.watch("reason")}
                options={STATE_REASONS}
                onChange={(value) =>
                  form.setValue("reason", value, { shouldValidate: true })
                }
              />
              <FieldError message={errors.reason?.message} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="state-date">Date</Label>
            <Input id="state-date" type="date" {...form.register("date")} />
            <FieldError message={errors.date?.message} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="state-notes">Notes</Label>
            <Textarea
              id="state-notes"
              rows={2}
              placeholder="What happened?"
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
            <Button type="submit" disabled={mutation.isPending || pool < 1}>
              {mutation.isPending ? "Saving…" : copy.action}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// --- stock details (location, needed, unit cost) ---

const detailsSchema = z.object({
  storageLocation: z.string(),
  needed: wholeNumber(0, "Enter a whole number of 0 or more"),
  unitCost: z.string(),
  firstDeployedYear: z.string().refine(
    (v) => v === "" || (Number.isInteger(Number(v)) && Number(v) >= 1900),
    "Enter a four-digit year",
  ),
});
type DetailsValues = z.infer<typeof detailsSchema>;

export function EditDetailsDialog({
  stock,
  open,
  onOpenChange,
}: StockDialogProps) {
  const mutation = useUpdateStock();
  const defaults = React.useMemo<DetailsValues>(
    () => ({
      storageLocation: stock.storageLocation ?? "",
      needed: String(stock.needed),
      unitCost:
        stock.unitCostCents != null ? String(stock.unitCostCents / 100) : "",
      firstDeployedYear:
        stock.firstDeployedYear != null ? String(stock.firstDeployedYear) : "",
    }),
    [stock.storageLocation, stock.needed, stock.unitCostCents, stock.firstDeployedYear],
  );
  const form = useForm<DetailsValues>({
    resolver: zodResolver(detailsSchema),
    defaultValues: defaults,
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset(defaults);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaults]);

  const onSubmit = form.handleSubmit((values) => {
    const unitCostCents = parseCents(values.unitCost);
    if (values.unitCost.trim() !== "" && unitCostCents == null) {
      form.setError("unitCost", { message: "Enter an amount like 24.50" });
      return;
    }
    mutation.mutate(
      {
        stockId: stock.id,
        storageLocation: values.storageLocation.trim() || null,
        neededQuantity: parseNum(values.needed)!,
        unitCostCents,
        firstDeployedYear:
          values.firstDeployedYear === ""
            ? null
            : Number(values.firstDeployedYear),
      },
      { onSuccess: () => onOpenChange(false) },
    );
  });

  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{stock.typeName} details</DialogTitle>
          <DialogDescription>
            Where spare stock is kept, how many you want on hand, and what one
            costs.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          onSubmit={onSubmit}
          onEscape={() => onOpenChange(false)}
          className="grid gap-4"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="stock-location">Storage location</Label>
            <Input
              id="stock-location"
              placeholder="e.g. Garage shelf B"
              {...form.register("storageLocation")}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="stock-needed">Needed</Label>
              <Input
                id="stock-needed"
                type="number"
                inputMode="numeric"
                step={1}
                min={0}
                {...form.register("needed")}
              />
              <FieldError message={errors.needed?.message} />
              <p className="text-xs text-muted-foreground">
                Target to keep available.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="stock-cost">Unit cost</Label>
              <Input
                id="stock-cost"
                inputMode="decimal"
                placeholder="e.g. 24.50"
                {...form.register("unitCost")}
              />
              <FieldError message={errors.unitCost?.message} />
              <p className="text-xs text-muted-foreground">
                Used to value losses.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="stock-first-year">First deployed year</Label>
              <Input
                id="stock-first-year"
                type="number"
                min={1900}
                max={new Date().getFullYear() + 1}
                placeholder="e.g. 2022"
                {...form.register("firstDeployedYear")}
              />
              <FieldError message={errors.firstDeployedYear?.message} />
            </div>
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
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// --- history ---

interface HistoryEntry {
  id: string;
  date: string;
  quantity: number;
  label: string;
  detail: string;
  tone: "positive" | "negative" | "neutral";
}

export function HistoryDialog({ stock, open, onOpenChange }: StockDialogProps) {
  const adjustments = useStockAdjustments(stock.id, open);
  const stateChanges = useStockStateChanges(stock.id, open);

  const isPending = adjustments.isPending || stateChanges.isPending;
  const isError = adjustments.isError || stateChanges.isError;

  const entries = React.useMemo<HistoryEntry[]>(() => {
    const rows: HistoryEntry[] = [];
    for (const adjustment of adjustments.data ?? []) {
      rows.push({
        id: adjustment.id,
        date: adjustment.date,
        quantity: adjustment.quantity,
        label: reasonLabel(adjustment.reason),
        detail: adjustment.notes ?? "Owned count",
        tone: adjustment.quantity >= 0 ? "positive" : "negative",
      });
    }
    for (const change of stateChanges.data ?? []) {
      rows.push({
        id: change.id,
        date: change.date,
        quantity: change.quantity,
        label: `${reasonLabel(change.reason)} · ${change.fromState} → ${change.toState}`,
        detail: change.notes ?? "Condition change",
        tone: change.toState === "serviceable" ? "positive" : "negative",
      });
    }
    return rows.sort((a, b) => b.date.localeCompare(a.date));
  }, [adjustments.data, stateChanges.data]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{stock.typeName} history</DialogTitle>
          <DialogDescription>
            Every ledger entry — counts and condition changes — most recent
            first.
          </DialogDescription>
        </DialogHeader>
        {isPending ? (
          <div className="grid gap-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : isError ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Could not load history.
          </p>
        ) : entries.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Nothing recorded yet.
          </p>
        ) : (
          <ul className="grid max-h-80 gap-2 overflow-y-auto">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center gap-3 rounded-lg border p-3"
              >
                <Badge
                  variant={entry.tone === "positive" ? "accent" : "destructive"}
                  className="w-12 justify-center tabular-nums"
                >
                  {entry.quantity > 0 ? "+" : ""}
                  {entry.quantity}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{entry.label}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {formatDate(entry.date)} · {entry.detail}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {stock.unitCostCents != null && (
          <p className="text-xs text-muted-foreground">
            Unit cost on file: {formatCents(stock.unitCostCents)}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
