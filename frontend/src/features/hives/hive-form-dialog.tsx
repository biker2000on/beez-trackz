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
import { useApiaries } from "@/features/apiaries/hooks";
import { useCreateHive, useUpdateHive, type Hive } from "./hooks";
import {
  HIVE_STATUSES,
  HIVE_STATUS_LABELS,
  PLACEMENTS,
  PLACEMENT_LABELS,
  toDateInput,
} from "./lib";

const optionalInt = (label: string) =>
  z
    .string()
    .trim()
    .refine(
      (value) =>
        value === "" || (Number.isInteger(Number(value)) && Number(value) >= 1),
      { message: `${label} must be a positive whole number` },
    );

const hiveSchema = z.object({
  apiaryId: z.string().min(1, "Apiary is required"),
  standId: z.string().trim().max(8, "Keep the stand label short"),
  slotRow: optionalInt("Row"),
  slotCol: optionalInt("Column"),
  placement: z.string(),
  positionLabel: z.string().trim(),
  status: z.string(),
  installedDate: z.string(),
  notes: z.string(),
});

type HiveValues = z.infer<typeof hiveSchema>;

function toValues(hive?: Hive | null, defaultApiaryId?: string): HiveValues {
  return {
    apiaryId: hive?.apiaryId ?? defaultApiaryId ?? "",
    standId: hive?.standId ?? "",
    slotRow: hive?.slotRow != null ? String(hive.slotRow) : "",
    slotCol: hive?.slotCol != null ? String(hive.slotCol) : "",
    placement: hive?.placement ?? "full",
    positionLabel: hive?.positionLabel ?? "",
    status: hive?.status ?? "active",
    installedDate: toDateInput(hive?.installedDate),
    notes: hive?.notes ?? "",
  };
}

/** Mirrors the server's auto label: "{stand}{row}-{col}" + placement suffix. */
function generatedLabel(values: HiveValues): string {
  if (!values.standId && !values.slotRow && !values.slotCol) return "";
  let label = values.standId || "?";
  if (values.slotRow) label += values.slotRow;
  if (values.slotCol) label += `-${values.slotCol}`;
  if (values.placement && values.placement !== "full") {
    label += ` (${values.placement})`;
  }
  return label;
}

export function HiveFormDialog({
  open,
  onOpenChange,
  hive,
  defaultApiaryId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog edits this hive; otherwise it creates one. */
  hive?: Hive | null;
  /** Preselected apiary for the create form (e.g. from an apiary page). */
  defaultApiaryId?: string;
}) {
  const isEdit = Boolean(hive);
  const apiaries = useApiaries();
  const createHive = useCreateHive();
  const updateHive = useUpdateHive(hive?.id ?? "");

  const form = useForm<HiveValues>({
    resolver: zodResolver(hiveSchema),
    defaultValues: toValues(hive, defaultApiaryId),
  });

  React.useEffect(() => {
    if (open) form.reset(toValues(hive, defaultApiaryId));
  }, [open, hive, defaultApiaryId, form]);

  const watched = form.watch();
  const autoLabel = generatedLabel(watched);

  async function onSubmit(values: HiveValues, resetAfter = false) {
    const label = values.positionLabel || autoLabel;
    if (!label) {
      form.setError("positionLabel", {
        message: "Enter a position label or a stand location",
      });
      return;
    }
    const payload = {
      apiaryId: values.apiaryId,
      positionLabel: label,
      standId: values.standId === "" ? null : values.standId,
      slotRow: values.slotRow === "" ? null : Number(values.slotRow),
      slotCol: values.slotCol === "" ? null : Number(values.slotCol),
      placement: values.placement,
      status: values.status,
      installedDate: values.installedDate === "" ? null : values.installedDate,
      notes: values.notes.trim() === "" ? null : values.notes,
    };
    try {
      if (isEdit) {
        await updateHive.mutateAsync(payload);
        toast.success("Hive updated");
      } else {
        await createHive.mutateAsync(payload);
        toast.success("Hive created");
      }
      if (resetAfter && !isEdit) {
        form.reset(toValues(null, defaultApiaryId));
        requestAnimationFrame(() => form.setFocus("positionLabel"));
      } else {
        onOpenChange(false);
      }
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not save the hive",
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit hive" : "New hive"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update this hive's details."
              : "Add a hive to one of your apiaries."}
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          onSubmit={form.handleSubmit((values) => onSubmit(values))}
          onSubmitAndReset={form.handleSubmit((values) => onSubmit(values, true))}
          onEscape={() => onOpenChange(false)}
          className="grid gap-4"
          noValidate
        >
          <div className="grid gap-2">
            <Label>Apiary</Label>
            <Select
              value={watched.apiaryId}
              onValueChange={(value) =>
                form.setValue("apiaryId", value, { shouldValidate: true })
              }
              disabled={isEdit}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select an apiary" />
              </SelectTrigger>
              <SelectContent>
                {apiaries.data?.map((apiary) => (
                  <SelectItem key={apiary.id} value={apiary.id}>
                    {apiary.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isEdit && (
              <p className="text-xs text-muted-foreground">
                Use the location history tab to move a hive between apiaries.
              </p>
            )}
            {form.formState.errors.apiaryId && (
              <p className="text-sm text-destructive" role="alert">
                {form.formState.errors.apiaryId.message}
              </p>
            )}
          </div>

          <fieldset className="grid grid-cols-3 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="hive-stand">Stand</Label>
              <Input
                id="hive-stand"
                placeholder="A"
                aria-invalid={form.formState.errors.standId ? true : undefined}
                {...form.register("standId")}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="hive-row">Row</Label>
              <Input
                id="hive-row"
                inputMode="numeric"
                placeholder="1"
                aria-invalid={form.formState.errors.slotRow ? true : undefined}
                {...form.register("slotRow")}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="hive-col">Column</Label>
              <Input
                id="hive-col"
                inputMode="numeric"
                placeholder="1"
                aria-invalid={form.formState.errors.slotCol ? true : undefined}
                {...form.register("slotCol")}
              />
            </div>
          </fieldset>
          {(form.formState.errors.slotRow || form.formState.errors.slotCol) && (
            <p className="-mt-2 text-sm text-destructive" role="alert">
              {form.formState.errors.slotRow?.message ??
                form.formState.errors.slotCol?.message}
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>Placement</Label>
              <Select
                value={watched.placement}
                onValueChange={(value) => form.setValue("placement", value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLACEMENTS.map((placement) => (
                    <SelectItem key={placement} value={placement}>
                      {PLACEMENT_LABELS[placement]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Status</Label>
              <Select
                value={watched.status}
                onValueChange={(value) => form.setValue("status", value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HIVE_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {HIVE_STATUS_LABELS[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="hive-label">Position label</Label>
            <Input
              id="hive-label"
              placeholder={autoLabel || "e.g. A1-1"}
              aria-invalid={
                form.formState.errors.positionLabel ? true : undefined
              }
              {...form.register("positionLabel")}
            />
            <p className="text-xs text-muted-foreground">
              {autoLabel
                ? `Leave blank to use the generated label "${autoLabel}".`
                : "Required unless a stand location is set."}
            </p>
            {form.formState.errors.positionLabel && (
              <p className="text-sm text-destructive" role="alert">
                {form.formState.errors.positionLabel.message}
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="hive-installed">Installed date</Label>
            <Input
              id="hive-installed"
              type="date"
              {...form.register("installedDate")}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="hive-notes">Notes</Label>
            <Textarea id="hive-notes" rows={2} {...form.register("notes")} />
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
              {form.formState.isSubmitting
                ? "Saving…"
                : isEdit
                  ? "Save changes"
                  : "Create hive"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}
