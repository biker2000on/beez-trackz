"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { ApiError } from "@/lib/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { todayInput, toDateInput } from "@/features/hives/lib";
import {
  useCreateInspection,
  useUpdateInspection,
  type Inspection,
} from "./hooks";

const NOT_RATED = "none";

const ratingField = z.string();

const inspectionSchema = z.object({
  date: z.string().min(1, "Date is required"),
  inspectorName: z.string(),
  queenSeen: z.boolean(),
  queenHealth: z.string(),
  broodPattern: z.string(),
  storesHoney: ratingField,
  storesPollen: ratingField,
  temperament: ratingField,
  pests: z.array(
    z.object({
      type: z.string().trim().min(1, "Pest type is required"),
      count: z
        .string()
        .trim()
        .refine(
          (value) =>
            value === "" ||
            (Number.isInteger(Number(value)) && Number(value) >= 0),
          { message: "Count must be a whole number" },
        ),
    }),
  ),
  treatments: z.array(
    z.object({
      product: z.string().trim().min(1, "Product is required"),
      method: z.string(),
    }),
  ),
  miteMethod: z.string(),
  miteCount: z.string(),
  miteSampleSize: z.string(),
  miteDaysOnBoard: z.string(),
  miteNotes: z.string(),
  notes: z.string(),
});

type InspectionValues = z.infer<typeof inspectionSchema>;

function toValues(inspection?: Inspection | null): InspectionValues {
  return {
    date: inspection ? toDateInput(inspection.date) : todayInput(),
    inspectorName: inspection?.inspectorName ?? "",
    queenSeen: inspection?.queenSeen ?? false,
    queenHealth: inspection?.queenHealth ?? "",
    broodPattern: inspection?.broodPattern ?? "",
    storesHoney:
      inspection?.storesHoney != null
        ? String(inspection.storesHoney)
        : NOT_RATED,
    storesPollen:
      inspection?.storesPollen != null
        ? String(inspection.storesPollen)
        : NOT_RATED,
    temperament:
      inspection?.temperament != null
        ? String(inspection.temperament)
        : NOT_RATED,
    pests: (inspection?.pests ?? []).map((pest) => ({
      type: pest.type,
      count: pest.count != null ? String(pest.count) : "",
    })),
    treatments: (inspection?.treatments ?? []).map((treatment) => ({
      product: treatment.product,
      method: treatment.method ?? "",
    })),
    miteMethod: inspection?.miteCounts?.[0]?.method ?? "none",
    miteCount:
      inspection?.miteCounts?.[0] != null
        ? String(inspection.miteCounts[0].mitesCount)
        : "",
    miteSampleSize:
      inspection?.miteCounts?.[0]?.sampleSize != null
        ? String(inspection.miteCounts[0].sampleSize)
        : "300",
    miteDaysOnBoard:
      inspection?.miteCounts?.[0]?.daysOnBoard != null
        ? String(inspection.miteCounts[0].daysOnBoard)
        : "1",
    miteNotes: inspection?.miteCounts?.[0]?.notes ?? "",
    notes: inspection?.notes ?? "",
  };
}

function RatingSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder="Not rated" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NOT_RATED}>Not rated</SelectItem>
          {[1, 2, 3, 4, 5].map((n) => (
            <SelectItem key={n} value={String(n)}>
              {n} — {["Very poor", "Poor", "Average", "Good", "Excellent"][n - 1]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

export function InspectionFormDialog({
  open,
  onOpenChange,
  hiveId,
  inspection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hiveId: string;
  /** When set, the dialog edits this inspection; otherwise it creates one. */
  inspection?: Inspection | null;
}) {
  const isEdit = Boolean(inspection);
  const createInspection = useCreateInspection();
  const updateInspection = useUpdateInspection();

  const form = useForm<InspectionValues>({
    resolver: zodResolver(inspectionSchema),
    defaultValues: toValues(inspection),
  });
  const pests = useFieldArray({ control: form.control, name: "pests" });
  const treatments = useFieldArray({
    control: form.control,
    name: "treatments",
  });
  const [discardOpen, setDiscardOpen] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      form.reset(toValues(inspection));
      setDiscardOpen(false);
    }
  }, [open, inspection, form]);

  const watched = form.watch();
  const isDirty = form.formState.isDirty;

  function requestClose() {
    if (isDirty) setDiscardOpen(true);
    else onOpenChange(false);
  }

  function discardAndClose() {
    setDiscardOpen(false);
    onOpenChange(false);
  }

  function handleOpenChange(next: boolean) {
    if (next) onOpenChange(true);
    else requestClose();
  }

  function scrollFirstError() {
    requestAnimationFrame(() => {
      const root = document.querySelector<HTMLElement>(
        '[data-slot="dialog-content"]',
      );
      const invalid =
        root?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
        root?.querySelector<HTMLElement>('[role="alert"]');
      if (!invalid) return;
      invalid.scrollIntoView({ block: "center", behavior: "smooth" });
      invalid.focus({ preventScroll: true });
    });
  }

  function rating(value: string): number | null {
    return value === NOT_RATED ? null : Number(value);
  }

  async function onSubmit(values: InspectionValues, resetAfter = false) {
    const miteCount = values.miteCount.trim() === "" ? null : Number(values.miteCount);
    const miteSample = values.miteSampleSize.trim() === "" ? undefined : Number(values.miteSampleSize);
    const miteDays = values.miteDaysOnBoard.trim() === "" ? undefined : Number(values.miteDaysOnBoard);
    if (values.miteMethod !== "none") {
      let miteInvalid = false;
      if (miteCount == null || !Number.isInteger(miteCount) || miteCount < 0) {
        form.setError("miteCount", {
          message: "Enter a non-negative mite count",
        });
        miteInvalid = true;
      }
      const needsSample =
        values.miteMethod !== "sticky_board" && values.miteMethod !== "visual";
      if (
        needsSample &&
        (miteSample == null || !Number.isInteger(miteSample) || miteSample <= 0)
      ) {
        form.setError("miteSampleSize", {
          message: "Enter a positive sample size",
        });
        miteInvalid = true;
      }
      if (
        !needsSample &&
        (miteDays == null || !Number.isInteger(miteDays) || miteDays <= 0)
      ) {
        form.setError("miteDaysOnBoard", {
          message: "Enter days the board was on the hive",
        });
        miteInvalid = true;
      }
      if (miteInvalid) {
        scrollFirstError();
        return;
      }
    }
    const payload = {
      date: values.date,
      inspectorName:
        values.inspectorName.trim() === "" ? null : values.inspectorName,
      queenSeen: values.queenSeen,
      queenHealth:
        values.queenHealth.trim() === "" ? null : values.queenHealth,
      broodPattern:
        values.broodPattern.trim() === "" ? null : values.broodPattern,
      storesHoney: rating(values.storesHoney),
      storesPollen: rating(values.storesPollen),
      temperament: rating(values.temperament),
      pests: values.pests.map((pest) => ({
        type: pest.type,
        // The API stores count as free text ("12", "low", "heavy") — never a number.
        count: pest.count.trim() === "" ? null : pest.count,
      })),
      treatments: values.treatments.map((treatment) => ({
        product: treatment.product,
        method: treatment.method.trim() === "" ? null : treatment.method,
      })),
      miteCounts:
        values.miteMethod !== "none" && miteCount != null
          ? [{
              method: values.miteMethod as "alcohol_wash" | "sugar_roll" | "sticky_board" | "visual",
              mitesCount: miteCount,
              sampleSize:
                values.miteMethod === "sticky_board" || values.miteMethod === "visual"
                  ? undefined
                  : miteSample,
              daysOnBoard:
                values.miteMethod === "sticky_board" || values.miteMethod === "visual"
                  ? miteDays
                  : undefined,
              notes: values.miteNotes.trim() || undefined,
            }]
          : [],
      notes: values.notes.trim() === "" ? null : values.notes,
    };
    try {
      if (isEdit && inspection) {
        await updateInspection.mutateAsync({ id: inspection.id, ...payload });
        toast.success("Inspection updated");
      } else {
        await createInspection.mutateAsync({ hiveId, ...payload });
        toast.success("Inspection recorded");
      }
      if (resetAfter && !isEdit) {
        form.reset(toValues(null));
        requestAnimationFrame(() => form.setFocus("date"));
      } else {
        onOpenChange(false);
      }
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not save the inspection",
      );
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit inspection" : "New inspection"}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the recorded observations."
              : "Record what you observed in the hive."}
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          onSubmit={form.handleSubmit(
            (values) => onSubmit(values),
            () => scrollFirstError(),
          )}
          onSubmitAndReset={form.handleSubmit(
            (values) => onSubmit(values, true),
            () => scrollFirstError(),
          )}
          onEscape={requestClose}
          className="grid gap-5"
          noValidate
        >
          <section className="grid gap-3">
            <SectionHeading>Basics</SectionHeading>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="inspection-date">Date</Label>
                <Input
                  id="inspection-date"
                  type="date"
                  aria-invalid={form.formState.errors.date ? true : undefined}
                  {...form.register("date")}
                />
                {form.formState.errors.date && (
                  <p className="text-sm text-destructive" role="alert">
                    {form.formState.errors.date.message}
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="inspection-inspector">Inspector</Label>
                <Input
                  id="inspection-inspector"
                  placeholder="Optional"
                  {...form.register("inspectorName")}
                />
              </div>
            </div>
          </section>

          <Separator />

          <section className="grid gap-3">
            <SectionHeading>Varroa count</SectionHeading>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-2">
                <Label>Method</Label>
                <Select
                  value={watched.miteMethod}
                  onValueChange={(value) =>
                    form.setValue("miteMethod", value, { shouldDirty: true })
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not counted</SelectItem>
                    <SelectItem value="alcohol_wash">Alcohol wash</SelectItem>
                    <SelectItem value="sugar_roll">Sugar roll</SelectItem>
                    <SelectItem value="sticky_board">Sticky board</SelectItem>
                    <SelectItem value="visual">Visual count</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="inspection-mite-count">Mites</Label>
                <Input
                  id="inspection-mite-count"
                  type="number"
                  min="0"
                  step="1"
                  disabled={watched.miteMethod === "none"}
                  aria-invalid={
                    form.formState.errors.miteCount ? true : undefined
                  }
                  {...form.register("miteCount")}
                />
                {form.formState.errors.miteCount && (
                  <p className="text-sm text-destructive" role="alert">
                    {form.formState.errors.miteCount.message}
                  </p>
                )}
              </div>
              {watched.miteMethod === "sticky_board" || watched.miteMethod === "visual" ? (
                <div className="grid gap-2">
                  <Label htmlFor="inspection-mite-days">Days on board</Label>
                  <Input
                    id="inspection-mite-days"
                    type="number"
                    min="1"
                    step="1"
                    aria-invalid={
                      form.formState.errors.miteDaysOnBoard ? true : undefined
                    }
                    {...form.register("miteDaysOnBoard")}
                  />
                  {form.formState.errors.miteDaysOnBoard && (
                    <p className="text-sm text-destructive" role="alert">
                      {form.formState.errors.miteDaysOnBoard.message}
                    </p>
                  )}
                </div>
              ) : (
                <div className="grid gap-2">
                  <Label htmlFor="inspection-mite-sample">Bees sampled</Label>
                  <Input
                    id="inspection-mite-sample"
                    type="number"
                    min="1"
                    step="1"
                    disabled={watched.miteMethod === "none"}
                    aria-invalid={
                      form.formState.errors.miteSampleSize ? true : undefined
                    }
                    {...form.register("miteSampleSize")}
                  />
                  {form.formState.errors.miteSampleSize && (
                    <p className="text-sm text-destructive" role="alert">
                      {form.formState.errors.miteSampleSize.message}
                    </p>
                  )}
                </div>
              )}
            </div>
            <Input
              placeholder="Optional mite-count notes"
              disabled={watched.miteMethod === "none"}
              {...form.register("miteNotes")}
            />
          </section>
          <Separator />

          <section className="grid gap-3">
            <SectionHeading>Queen</SectionHeading>
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox
                checked={watched.queenSeen}
                onCheckedChange={(checked) =>
                  form.setValue("queenSeen", checked === true, {
                    shouldDirty: true,
                  })
                }
              />
              Queen seen
            </label>
            <div className="grid gap-2">
              <Label htmlFor="inspection-queen-health">Queen health</Label>
              <Input
                id="inspection-queen-health"
                placeholder="e.g. laying well, good pattern"
                {...form.register("queenHealth")}
              />
            </div>
          </section>

          <Separator />

          <section className="grid gap-3">
            <SectionHeading>Brood &amp; stores</SectionHeading>
            <div className="grid gap-2">
              <Label htmlFor="inspection-brood">Brood pattern</Label>
              <Input
                id="inspection-brood"
                placeholder="e.g. solid, spotty"
                {...form.register("broodPattern")}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <RatingSelect
                label="Honey stores"
                value={watched.storesHoney}
                onChange={(value) =>
                  form.setValue("storesHoney", value, { shouldDirty: true })
                }
              />
              <RatingSelect
                label="Pollen stores"
                value={watched.storesPollen}
                onChange={(value) =>
                  form.setValue("storesPollen", value, { shouldDirty: true })
                }
              />
              <RatingSelect
                label="Temperament"
                value={watched.temperament}
                onChange={(value) =>
                  form.setValue("temperament", value, { shouldDirty: true })
                }
              />
            </div>
          </section>

          <Separator />

          <section className="grid gap-3">
            <div className="flex items-center justify-between">
              <SectionHeading>Pests</SectionHeading>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => pests.append({ type: "", count: "" })}
              >
                <Plus className="size-4" />
                Add pest
              </Button>
            </div>
            {pests.fields.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No pests observed.
              </p>
            )}
            {pests.fields.map((field, index) => (
              <div key={field.id} className="flex items-start gap-2">
                <div className="grid flex-1 gap-1">
                  <Input
                    placeholder="Pest type, e.g. varroa"
                    aria-label={`Pest ${index + 1} type`}
                    aria-invalid={
                      form.formState.errors.pests?.[index]?.type
                        ? true
                        : undefined
                    }
                    {...form.register(`pests.${index}.type`)}
                  />
                  {form.formState.errors.pests?.[index]?.type && (
                    <p className="text-sm text-destructive" role="alert">
                      {form.formState.errors.pests[index]?.type?.message}
                    </p>
                  )}
                </div>
                <div className="grid w-24 gap-1">
                  <Input
                    placeholder="Count"
                    inputMode="numeric"
                    aria-label={`Pest ${index + 1} count`}
                    aria-invalid={
                      form.formState.errors.pests?.[index]?.count
                        ? true
                        : undefined
                    }
                    {...form.register(`pests.${index}.count`)}
                  />
                  {form.formState.errors.pests?.[index]?.count && (
                    <p className="text-sm text-destructive" role="alert">
                      {form.formState.errors.pests[index]?.count?.message}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove pest ${index + 1}`}
                  onClick={() => pests.remove(index)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </section>

          <Separator />

          <section className="grid gap-3">
            <div className="flex items-center justify-between">
              <SectionHeading>Treatments</SectionHeading>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => treatments.append({ product: "", method: "" })}
              >
                <Plus className="size-4" />
                Add treatment
              </Button>
            </div>
            {treatments.fields.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No treatments applied.
              </p>
            )}
            {treatments.fields.map((field, index) => (
              <div key={field.id} className="flex items-start gap-2">
                <div className="grid flex-1 gap-1">
                  <Input
                    placeholder="Product, e.g. Apiguard"
                    aria-label={`Treatment ${index + 1} product`}
                    aria-invalid={
                      form.formState.errors.treatments?.[index]?.product
                        ? true
                        : undefined
                    }
                    {...form.register(`treatments.${index}.product`)}
                  />
                  {form.formState.errors.treatments?.[index]?.product && (
                    <p className="text-sm text-destructive" role="alert">
                      {
                        form.formState.errors.treatments[index]?.product
                          ?.message
                      }
                    </p>
                  )}
                </div>
                <Input
                  className="w-36"
                  placeholder="Method"
                  aria-label={`Treatment ${index + 1} method`}
                  {...form.register(`treatments.${index}.method`)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove treatment ${index + 1}`}
                  onClick={() => treatments.remove(index)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </section>

          <Separator />

          <section className="grid gap-3">
            <SectionHeading>Notes</SectionHeading>
            <Textarea
              rows={3}
              placeholder="Anything else worth remembering…"
              {...form.register("notes")}
            />
          </section>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={requestClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting
                ? "Saving…"
                : isEdit
                  ? "Save changes"
                  : "Record inspection"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
      </Dialog>
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this inspection?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Closing discards them — nothing is
              recorded until you save.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={discardAndClose}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
