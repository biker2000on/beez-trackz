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
  useInspectionMiteCounts,
  useReplaceInspectionMiteCounts,
  type MiteMethod,
} from "@/features/operations/hooks";
import {
  useCreateInspection,
  useUpdateInspection,
  type Inspection,
} from "./hooks";

const NOT_RATED = "none";

const ratingField = z.string();
const frameCountField = z.string().refine(
  (value) =>
    value === "" || (Number.isInteger(Number(value)) && Number(value) >= 0),
  "Enter a non-negative whole number",
);

const inspectionSchema = z.object({
  date: z.string().min(1, "Date is required"),
  inspectorName: z.string(),
  queenSeen: z.boolean(),
  queenHealth: z.string(),
  broodPattern: z.string(),
  storesHoney: ratingField,
  storesPollen: ratingField,
  temperament: ratingField,
  framesOfBees: frameCountField,
  framesOfBrood: frameCountField,
  framesOfStores: frameCountField,
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
  miteCounts: z.array(
    z.object({
      id: z.string().optional(),
      method: z.enum(["alcohol_wash", "sugar_roll", "sticky_board", "visual"]),
      mitesCount: z.string(),
      sampleSize: z.string(),
      daysOnBoard: z.string(),
      notes: z.string(),
    }),
  ),
  notes: z.string(),
});

type InspectionValues = z.infer<typeof inspectionSchema>;

const MITE_METHODS: { value: MiteMethod; label: string }[] = [
  { value: "alcohol_wash", label: "Alcohol wash" },
  { value: "sugar_roll", label: "Sugar roll" },
  { value: "sticky_board", label: "Sticky board" },
  { value: "visual", label: "Visual count" },
];

function isBoardMiteMethod(method: string): boolean {
  return method === "sticky_board" || method === "visual";
}

function emptyMiteRow(): InspectionValues["miteCounts"][number] {
  return {
    method: "alcohol_wash",
    mitesCount: "",
    sampleSize: "300",
    daysOnBoard: "1",
    notes: "",
  };
}

function miteRowsFrom(
  counts?: {
    id: string;
    method: string;
    mitesCount: number;
    sampleSize: number | null;
    daysOnBoard: number | null;
    notes: string | null;
  }[],
): InspectionValues["miteCounts"] {
  return (counts ?? []).map((count) => ({
    id: count.id,
    method: count.method as MiteMethod,
    mitesCount: String(count.mitesCount),
    sampleSize: count.sampleSize != null ? String(count.sampleSize) : "300",
    daysOnBoard: count.daysOnBoard != null ? String(count.daysOnBoard) : "1",
    notes: count.notes ?? "",
  }));
}

function toValues(
  inspection?: Inspection | null,
  miteCounts?: {
    id: string;
    method: string;
    mitesCount: number;
    sampleSize: number | null;
    daysOnBoard: number | null;
    notes: string | null;
  }[],
): InspectionValues {
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
    framesOfBees:
      inspection?.framesOfBees != null ? String(inspection.framesOfBees) : "",
    framesOfBrood:
      inspection?.framesOfBrood != null ? String(inspection.framesOfBrood) : "",
    framesOfStores:
      inspection?.framesOfStores != null ? String(inspection.framesOfStores) : "",
    pests: (inspection?.pests ?? []).map((pest) => ({
      type: pest.type,
      count: pest.count != null ? String(pest.count) : "",
    })),
    treatments: (inspection?.treatments ?? []).map((treatment) => ({
      product: treatment.product,
      method: treatment.method ?? "",
    })),
    miteCounts: miteRowsFrom(miteCounts ?? inspection?.miteCounts),
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
  const replaceMiteCounts = useReplaceInspectionMiteCounts();
  const liveMiteCounts = useInspectionMiteCounts(inspection?.id);

  const form = useForm<InspectionValues>({
    resolver: zodResolver(inspectionSchema),
    defaultValues: toValues(inspection),
  });
  const pests = useFieldArray({ control: form.control, name: "pests" });
  const treatments = useFieldArray({
    control: form.control,
    name: "treatments",
  });
  const miteCounts = useFieldArray({
    control: form.control,
    name: "miteCounts",
  });
  const [discardOpen, setDiscardOpen] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      form.reset(toValues(inspection, liveMiteCounts.data));
      setDiscardOpen(false);
    }
  }, [open, inspection, liveMiteCounts.data, form]);

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

  function frameCount(value: string): number | null {
    return value.trim() === "" ? null : Number(value);
  }

  function parsedMiteCounts(values: InspectionValues) {
    const seen = new Set<string>();
    let miteInvalid = false;
    const rows: {
      id?: string;
      method: MiteMethod;
      mitesCount: number;
      sampleSize?: number;
      daysOnBoard?: number;
      notes?: string;
    }[] = [];
    values.miteCounts.forEach((row, index) => {
      if (seen.has(row.method)) {
        form.setError(`miteCounts.${index}.method`, {
          message: "Each method can only be recorded once",
        });
        miteInvalid = true;
      }
      seen.add(row.method);
      const mitesCount =
        row.mitesCount.trim() === "" ? null : Number(row.mitesCount);
      const sampleSize =
        row.sampleSize.trim() === "" ? undefined : Number(row.sampleSize);
      const daysOnBoard =
        row.daysOnBoard.trim() === "" ? undefined : Number(row.daysOnBoard);
      if (mitesCount == null || !Number.isInteger(mitesCount) || mitesCount < 0) {
        form.setError(`miteCounts.${index}.mitesCount`, {
          message: "Enter a non-negative mite count",
        });
        miteInvalid = true;
      }
      if (isBoardMiteMethod(row.method)) {
        if (
          daysOnBoard == null ||
          !Number.isInteger(daysOnBoard) ||
          daysOnBoard <= 0
        ) {
          form.setError(`miteCounts.${index}.daysOnBoard`, {
            message: "Enter days the board was on the hive",
          });
          miteInvalid = true;
        }
      } else if (
        sampleSize == null ||
        !Number.isInteger(sampleSize) ||
        sampleSize <= 0
      ) {
        form.setError(`miteCounts.${index}.sampleSize`, {
          message: "Enter a positive sample size",
        });
        miteInvalid = true;
      }
      if (miteInvalid || mitesCount == null) return;
      rows.push({
        id: row.id,
        method: row.method,
        mitesCount,
        sampleSize: isBoardMiteMethod(row.method) ? undefined : sampleSize,
        daysOnBoard: isBoardMiteMethod(row.method) ? daysOnBoard : undefined,
        notes: row.notes.trim() || undefined,
      });
    });
    return { miteInvalid, rows };
  }

  async function onSubmit(values: InspectionValues, resetAfter = false) {
    const { miteInvalid, rows } = parsedMiteCounts(values);
    if (miteInvalid) {
      scrollFirstError();
      return;
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
      framesOfBees: frameCount(values.framesOfBees),
      framesOfBrood: frameCount(values.framesOfBrood),
      framesOfStores: frameCount(values.framesOfStores),
      pests: values.pests.map((pest) => ({
        type: pest.type,
        // The API stores count as free text ("12", "low", "heavy") — never a number.
        count: pest.count.trim() === "" ? null : pest.count,
      })),
      treatments: values.treatments.map((treatment) => ({
        product: treatment.product,
        method: treatment.method.trim() === "" ? null : treatment.method,
      })),
      notes: values.notes.trim() === "" ? null : values.notes,
    };
    try {
      if (isEdit && inspection) {
        await updateInspection.mutateAsync({ id: inspection.id, ...payload });
        // The whole final mite-count set lands in ONE transactional request —
        // a per-row sequence could fail halfway (a method swap deterministically
        // collided with the unique index) and persist a partial edit.
        await replaceMiteCounts.mutateAsync({
          inspectionId: inspection.id,
          hiveId,
          counts: rows.map((row) => ({
            method: row.method,
            mitesCount: row.mitesCount,
            sampleSize: row.sampleSize,
            daysOnBoard: row.daysOnBoard,
            notes: row.notes,
          })),
        });
        toast.success("Inspection updated");
      } else {
        await createInspection.mutateAsync({
          hiveId,
          ...payload,
          miteCounts: rows.map((row) => ({
            method: row.method,
            mitesCount: row.mitesCount,
            sampleSize: row.sampleSize,
            daysOnBoard: row.daysOnBoard,
            notes: row.notes,
          })),
        });
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
            <div className="flex items-center justify-between">
              <SectionHeading>Varroa counts</SectionHeading>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const used = new Set(
                    (form.getValues("miteCounts") ?? []).map((row) => row.method),
                  );
                  const next =
                    MITE_METHODS.find((item) => !used.has(item.value)) ??
                    MITE_METHODS[0];
                  miteCounts.append({ ...emptyMiteRow(), method: next.value });
                }}
              >
                <Plus className="size-4" />
                Add count
              </Button>
            </div>
            {miteCounts.fields.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No structured mite counts.
              </p>
            )}
            {miteCounts.fields.map((field, index) => {
              const method = watched.miteCounts?.[index]?.method ?? field.method;
              const board = isBoardMiteMethod(method);
              return (
                <div key={field.id} className="grid gap-2 rounded-md border p-3">
                  <div className="grid gap-3 sm:grid-cols-[1.4fr_0.8fr_0.9fr_auto]">
                    <div className="grid gap-1">
                      <Label className="sr-only">Method</Label>
                      <Select
                        value={method}
                        onValueChange={(value) =>
                          form.setValue(
                            `miteCounts.${index}.method`,
                            value as MiteMethod,
                            { shouldDirty: true },
                          )
                        }
                      >
                        <SelectTrigger aria-label={`Mite count ${index + 1} method`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MITE_METHODS.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {form.formState.errors.miteCounts?.[index]?.method && (
                        <p className="text-sm text-destructive" role="alert">
                          {form.formState.errors.miteCounts[index]?.method?.message}
                        </p>
                      )}
                    </div>
                    <div className="grid gap-1">
                      <Label className="sr-only" htmlFor={`inspection-mite-count-${index}`}>
                        Mites
                      </Label>
                      <Input
                        id={`inspection-mite-count-${index}`}
                        type="number"
                        min="0"
                        step="1"
                        placeholder="Mites"
                        aria-label={`Mite count ${index + 1} mites`}
                        aria-invalid={
                          form.formState.errors.miteCounts?.[index]?.mitesCount
                            ? true
                            : undefined
                        }
                        {...form.register(`miteCounts.${index}.mitesCount`)}
                      />
                      {form.formState.errors.miteCounts?.[index]?.mitesCount && (
                        <p className="text-sm text-destructive" role="alert">
                          {
                            form.formState.errors.miteCounts[index]?.mitesCount
                              ?.message
                          }
                        </p>
                      )}
                    </div>
                    {board ? (
                      <div className="grid gap-1">
                        <Label className="sr-only" htmlFor={`inspection-mite-days-${index}`}>
                          Days on board
                        </Label>
                        <Input
                          id={`inspection-mite-days-${index}`}
                          type="number"
                          min="1"
                          step="1"
                          placeholder="Days on board"
                          aria-label={`Mite count ${index + 1} days on board`}
                          aria-invalid={
                            form.formState.errors.miteCounts?.[index]?.daysOnBoard
                              ? true
                              : undefined
                          }
                          {...form.register(`miteCounts.${index}.daysOnBoard`)}
                        />
                        {form.formState.errors.miteCounts?.[index]?.daysOnBoard && (
                          <p className="text-sm text-destructive" role="alert">
                            {
                              form.formState.errors.miteCounts[index]?.daysOnBoard
                                ?.message
                            }
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="grid gap-1">
                        <Label className="sr-only" htmlFor={`inspection-mite-sample-${index}`}>
                          Bees sampled
                        </Label>
                        <Input
                          id={`inspection-mite-sample-${index}`}
                          type="number"
                          min="1"
                          step="1"
                          placeholder="Bees sampled"
                          aria-label={`Mite count ${index + 1} bees sampled`}
                          aria-invalid={
                            form.formState.errors.miteCounts?.[index]?.sampleSize
                              ? true
                              : undefined
                          }
                          {...form.register(`miteCounts.${index}.sampleSize`)}
                        />
                        {form.formState.errors.miteCounts?.[index]?.sampleSize && (
                          <p className="text-sm text-destructive" role="alert">
                            {
                              form.formState.errors.miteCounts[index]?.sampleSize
                                ?.message
                            }
                          </p>
                        )}
                      </div>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove mite count ${index + 1}`}
                      onClick={() => miteCounts.remove(index)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  <Input
                    placeholder="Optional mite-count notes"
                    aria-label={`Mite count ${index + 1} notes`}
                    {...form.register(`miteCounts.${index}.notes`)}
                  />
                </div>
              );
            })}
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
            <div className="grid gap-3 sm:grid-cols-3">
              {([
                ["framesOfBees", "Frames of bees"],
                ["framesOfBrood", "Frames of brood"],
                ["framesOfStores", "Frames of stores"],
              ] as const).map(([name, label]) => (
                <div className="grid gap-2" key={name}>
                  <Label htmlFor={`inspection-${name}`}>{label}</Label>
                  <Input
                    id={`inspection-${name}`}
                    type="number"
                    min="0"
                    step="1"
                    placeholder="Optional"
                    aria-invalid={form.formState.errors[name] ? true : undefined}
                    {...form.register(name)}
                  />
                  {form.formState.errors[name] && (
                    <p className="text-sm text-destructive" role="alert">
                      {form.formState.errors[name]?.message}
                    </p>
                  )}
                </div>
              ))}
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
