"use client";

/** Add-stock and add-equipment-type dialogs. */

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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { parseCents, parseNum } from "./format";
import { useCreateStock, useCreateType, useEquipmentTypes } from "./hooks";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type EquipmentCategory,
} from "./types";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

interface AddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// --- add stock ---

const stockSchema = z.object({
  typeId: z.string().min(1, "Equipment type is required"),
  initialQuantity: z
    .string()
    .refine(
      (v) =>
        v.trim() === "" ||
        (Number.isInteger(parseNum(v) ?? NaN) && (parseNum(v) ?? -1) >= 0),
      "Enter a whole number of 0 or more",
    ),
  neededQuantity: z
    .string()
    .refine(
      (v) =>
        v.trim() === "" ||
        (Number.isInteger(parseNum(v) ?? NaN) && (parseNum(v) ?? -1) >= 0),
      "Enter a whole number of 0 or more",
    ),
  unitCost: z.string(),
  firstDeployedYear: z.string().refine(
    (v) => v === "" || (Number.isInteger(Number(v)) && Number(v) >= 1900),
    "Enter a four-digit year",
  ),
  frameCondition: z.string(),
  storageLocation: z.string(),
  notes: z.string(),
});
type StockValues = z.infer<typeof stockSchema>;

const EMPTY_STOCK: StockValues = {
  typeId: "",
  initialQuantity: "0",
  neededQuantity: "0",
  unitCost: "",
  firstDeployedYear: "",
  frameCondition: "unspecified",
  storageLocation: "",
  notes: "",
};

export function AddStockDialog({ open, onOpenChange }: AddDialogProps) {
  const types = useEquipmentTypes();
  const mutation = useCreateStock();
  const form = useForm<StockValues>({
    resolver: zodResolver(stockSchema),
    defaultValues: EMPTY_STOCK,
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset(EMPTY_STOCK);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const typeList = types.data ?? [];
  const selectedType = typeList.find((t) => t.id === form.watch("typeId"));
  const isFrame = selectedType?.category === "frame";

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    items: typeList.filter((t) => t.category === category),
  })).filter((group) => group.items.length > 0);

  const submitStock = (resetAfter: boolean) => form.handleSubmit((values) => {
    const condition = values.frameCondition;
    const unitCostCents = parseCents(values.unitCost);
    if (values.unitCost.trim() !== "" && unitCostCents == null) {
      form.setError("unitCost", { message: "Enter an amount like 24.50" });
      return;
    }
    mutation.mutate(
      {
        typeId: values.typeId,
        initialQuantity: parseNum(values.initialQuantity) ?? 0,
        neededQuantity: parseNum(values.neededQuantity) ?? 0,
        unitCostCents,
        firstDeployedYear:
          values.firstDeployedYear === ""
            ? undefined
            : Number(values.firstDeployedYear),
        storageLocation: values.storageLocation.trim() || undefined,
        notes: values.notes.trim() || undefined,
        ...(isFrame && (condition === "drawn" || condition === "fresh")
          ? { frameCondition: condition }
          : {}),
      },
      {
        onSuccess: () => {
          if (resetAfter) form.reset(EMPTY_STOCK);
          else onOpenChange(false);
        },
      },
    );
  });
  const onSubmit = submitStock(false);

  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add stock</DialogTitle>
          <DialogDescription>
            Start tracking a batch of equipment you own.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          onSubmit={onSubmit}
          onSubmitAndReset={submitStock(true)}
          onEscape={() => onOpenChange(false)}
          className="grid gap-4"
        >
          <div className="grid gap-1.5">
            <Label>Equipment type</Label>
            <Select
              value={form.watch("typeId")}
              onValueChange={(value) =>
                form.setValue("typeId", value, { shouldValidate: true })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a type" />
              </SelectTrigger>
              <SelectContent>
                {grouped.map((group) => (
                  <SelectGroup key={group.category}>
                    <SelectLabel>{CATEGORY_LABELS[group.category]}</SelectLabel>
                    {group.items.map((type) => (
                      <SelectItem key={type.id} value={type.id}>
                        {type.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={errors.typeId?.message} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="stock-quantity">Initial quantity</Label>
              <Input
                id="stock-quantity"
                type="number"
                inputMode="numeric"
                step={1}
                min={0}
                {...form.register("initialQuantity")}
              />
              <FieldError message={errors.initialQuantity?.message} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="stock-needed">Needed</Label>
              <Input
                id="stock-needed"
                type="number"
                inputMode="numeric"
                step={1}
                min={0}
                {...form.register("neededQuantity")}
              />
              <FieldError message={errors.neededQuantity?.message} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="stock-unit-cost">Unit cost</Label>
              <Input
                id="stock-unit-cost"
                inputMode="decimal"
                placeholder="e.g. 24.50"
                {...form.register("unitCost")}
              />
              <FieldError message={errors.unitCost?.message} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="stock-first-deployed">First deployed year</Label>
              <Input
                id="stock-first-deployed"
                type="number"
                min={1900}
                max={new Date().getFullYear() + 1}
                placeholder="e.g. 2022"
                {...form.register("firstDeployedYear")}
              />
              <FieldError message={errors.firstDeployedYear?.message} />
            </div>
            {isFrame && (
              <div className="grid gap-1.5">
                <Label>Frame condition</Label>
                <Select
                  value={form.watch("frameCondition")}
                  onValueChange={(value) =>
                    form.setValue("frameCondition", value)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unspecified">Unspecified</SelectItem>
                    <SelectItem value="drawn">Drawn comb</SelectItem>
                    <SelectItem value="fresh">Fresh foundation</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="stock-location">Storage location</Label>
            <Input
              id="stock-location"
              placeholder="e.g. Garage shelf B"
              {...form.register("storageLocation")}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="stock-notes">Notes</Label>
            <Textarea
              id="stock-notes"
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
              {mutation.isPending ? "Adding…" : "Add stock"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// --- add equipment type ---

const typeSchema = z.object({
  name: z.string().min(1, "Name is required"),
  category: z.string().min(1, "Category is required"),
  framesPerBox: z
    .string()
    .refine(
      (v) =>
        v.trim() === "" ||
        (Number.isInteger(parseNum(v) ?? NaN) && (parseNum(v) ?? 0) > 0),
      "Enter a whole number greater than zero",
    ),
});
type TypeValues = z.infer<typeof typeSchema>;

export function AddTypeDialog({ open, onOpenChange }: AddDialogProps) {
  const mutation = useCreateType();
  const form = useForm<TypeValues>({
    resolver: zodResolver(typeSchema),
    defaultValues: { name: "", category: "", framesPerBox: "" },
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset({ name: "", category: "", framesPerBox: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isBox = form.watch("category") === "box";

  const submitType = (resetAfter: boolean) => form.handleSubmit((values) => {
    const framesPerBox = parseNum(values.framesPerBox);
    mutation.mutate(
      {
        name: values.name.trim(),
        category: values.category,
        ...(isBox && framesPerBox != null ? { framesPerBox } : {}),
      },
      {
        onSuccess: () => {
          if (resetAfter) form.reset({ name: "", category: "", framesPerBox: "" });
          else onOpenChange(false);
        },
      },
    );
  });
  const onSubmit = submitType(false);

  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New equipment type</DialogTitle>
          <DialogDescription>
            Add a custom type to the equipment catalog.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          onSubmit={onSubmit}
          onSubmitAndReset={submitType(true)}
          onEscape={() => onOpenChange(false)}
          className="grid gap-4"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="type-name">Name</Label>
            <Input
              id="type-name"
              placeholder="e.g. Slatted Rack"
              {...form.register("name")}
            />
            <FieldError message={errors.name?.message} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Category</Label>
              <Select
                value={form.watch("category")}
                onValueChange={(value) =>
                  form.setValue("category", value, { shouldValidate: true })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose a category" />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_ORDER.map((category: EquipmentCategory) => (
                    <SelectItem key={category} value={category}>
                      {CATEGORY_LABELS[category]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={errors.category?.message} />
            </div>
            {isBox && (
              <div className="grid gap-1.5">
                <Label htmlFor="type-frames">Frames per box</Label>
                <Input
                  id="type-frames"
                  type="number"
                  inputMode="numeric"
                  step={1}
                  min={1}
                  placeholder="10"
                  {...form.register("framesPerBox")}
                />
                <FieldError message={errors.framesPerBox?.message} />
              </div>
            )}
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
              {mutation.isPending ? "Adding…" : "Add type"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}
