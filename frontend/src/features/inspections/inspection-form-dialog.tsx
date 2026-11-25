"use client";

import * as React from "react";
import { toast } from "sonner";

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
import { Skeleton } from "@/components/ui/skeleton";
import { todayInput, toDateInput } from "@/features/hives/lib";
import {
  useInspectionMiteCounts,
  useReplaceInspectionMiteCounts,
} from "@/features/operations/hooks";
import {
  useCreateInspection,
  useUpdateInspection,
  type Inspection,
  type InspectionPayload,
} from "./hooks";
import {
  DEFAULT_SAMPLE_SIZE,
  emptyInspectionValues,
  InspectionFields,
  isBlankMiteRow,
  isBoardMiteMethod,
  validateInspectionValues,
  type InspectionFieldErrors,
  type InspectionFieldValues,
  type MiteMethod,
} from "./inspection-fields";

type StoredMiteCount = {
  id: string;
  method: string;
  mitesCount: number;
  sampleSize: number | null;
  daysOnBoard: number | null;
  notes: string | null;
};

const rating = (value: number | null | undefined) =>
  value != null ? String(value) : "";

function fromInspection(
  inspection: Inspection | null | undefined,
  miteCounts: StoredMiteCount[] | undefined,
): InspectionFieldValues {
  const base = emptyInspectionValues();
  if (!inspection) return base;
  return {
    ...base,
    // Unknown stays unknown: an inspection saved without a queen observation
    // must not reopen as "not seen".
    queenSeen: inspection.queenSeen ?? null,
    queenHealth: inspection.queenHealth ?? "",
    broodPattern: inspection.broodPattern ?? "",
    storesHoney: rating(inspection.storesHoney),
    storesPollen: rating(inspection.storesPollen),
    temperament: rating(inspection.temperament),
    framesOfBees: rating(inspection.framesOfBees),
    framesOfBrood: rating(inspection.framesOfBrood),
    framesOfStores: rating(inspection.framesOfStores),
    pests: (inspection.pests ?? []).map((pest) => ({
      type: pest.type,
      count: pest.count != null ? String(pest.count) : "",
    })),
    treatments: (inspection.treatments ?? []).map((treatment) => ({
      product: treatment.product,
      method: treatment.method ?? "",
    })),
    miteCounts: (miteCounts ?? inspection.miteCounts ?? []).map((count) => ({
      id: count.id,
      method: count.method as MiteMethod,
      mitesCount: String(count.mitesCount),
      sampleSize:
        count.sampleSize != null ? String(count.sampleSize) : DEFAULT_SAMPLE_SIZE,
      daysOnBoard: count.daysOnBoard != null ? String(count.daysOnBoard) : "1",
      notes: count.notes ?? "",
    })),
    notes: inspection.notes ?? "",
  };
}

const optionalNumber = (value: string) =>
  value.trim() === "" ? null : Number(value);
const optionalText = (value: string) => (value.trim() === "" ? null : value.trim());

function miteRows(values: InspectionFieldValues) {
  return values.miteCounts
    .filter((row) => !isBlankMiteRow(row))
    .map((row) => {
      const board = isBoardMiteMethod(row.method);
      return {
        method: row.method,
        mitesCount: Number(row.mitesCount),
        sampleSize: board ? undefined : Number(row.sampleSize),
        daysOnBoard: board ? Number(row.daysOnBoard) : undefined,
        notes: row.notes.trim() || undefined,
      };
    });
}

function toInspectionPayload(
  date: string,
  inspectorName: string,
  values: InspectionFieldValues,
): InspectionPayload {
  return {
    date,
    inspectorName: optionalText(inspectorName),
    queenSeen: values.queenSeen,
    queenHealth: optionalText(values.queenHealth),
    broodPattern: optionalText(values.broodPattern),
    storesHoney: optionalNumber(values.storesHoney),
    storesPollen: optionalNumber(values.storesPollen),
    temperament: optionalNumber(values.temperament),
    framesOfBees: optionalNumber(values.framesOfBees),
    framesOfBrood: optionalNumber(values.framesOfBrood),
    framesOfStores: optionalNumber(values.framesOfStores),
    pests: values.pests.map((pest) => ({
      type: pest.type.trim(),
      // The API stores count as free text ("12", "low", "heavy").
      count: optionalText(pest.count),
    })),
    treatments: values.treatments.map((treatment) => ({
      product: treatment.product.trim(),
      method: optionalText(treatment.method),
    })),
    notes: optionalText(values.notes),
  };
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
  const liveMiteCounts = useInspectionMiteCounts(open ? inspection?.id : undefined);
  /** The open form's close request, which asks before discarding edits. */
  const requestCloseRef = React.useRef<(() => void) | null>(null);
  const waitingForCounts = isEdit && liveMiteCounts.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else if (requestCloseRef.current) requestCloseRef.current();
        else onOpenChange(false);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit inspection" : "Log inspection"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update what was recorded for this visit."
              : "Record what you saw in the hive. A note alone is enough."}
          </DialogDescription>
        </DialogHeader>
        {waitingForCounts ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          // Mounted per open, so every open starts from the saved record.
          <InspectionForm
            hiveId={hiveId}
            inspection={inspection}
            miteCounts={liveMiteCounts.data}
            onClose={() => onOpenChange(false)}
            requestCloseRef={requestCloseRef}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function InspectionForm({
  hiveId,
  inspection,
  miteCounts,
  onClose,
  requestCloseRef,
}: {
  hiveId: string;
  inspection?: Inspection | null;
  miteCounts?: StoredMiteCount[];
  onClose: () => void;
  requestCloseRef: React.RefObject<(() => void) | null>;
}) {
  const isEdit = Boolean(inspection);
  const createInspection = useCreateInspection();
  const updateInspection = useUpdateInspection();
  const replaceMiteCounts = useReplaceInspectionMiteCounts();

  const [date, setDate] = React.useState(() =>
    inspection ? toDateInput(inspection.date) : todayInput(),
  );
  const [inspectorName, setInspectorName] = React.useState(
    () => inspection?.inspectorName ?? "",
  );
  const [values, setValues] = React.useState(() =>
    fromInspection(inspection, miteCounts),
  );
  const [baseline, setBaseline] = React.useState(() =>
    JSON.stringify([date, inspectorName, values]),
  );
  const [errors, setErrors] = React.useState<InspectionFieldErrors>({});
  const [dateError, setDateError] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [discardOpen, setDiscardOpen] = React.useState(false);
  // Bumped after "save and log another" so the fields remount collapsed.
  const [round, setRound] = React.useState(0);
  const formRef = React.useRef<HTMLFormElement>(null);
  const dateRef = React.useRef<HTMLInputElement>(null);

  const dirty = JSON.stringify([date, inspectorName, values]) !== baseline;
  const requestClose = React.useCallback(() => {
    if (dirty) setDiscardOpen(true);
    else onClose();
  }, [dirty, onClose]);
  React.useEffect(() => {
    requestCloseRef.current = requestClose;
    return () => {
      requestCloseRef.current = null;
    };
  }, [requestClose, requestCloseRef]);

  function focusFirstError() {
    requestAnimationFrame(() => {
      const invalid =
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
        formRef.current?.querySelector<HTMLElement>('[role="alert"]');
      if (!invalid) return;
      invalid.scrollIntoView({ block: "center", behavior: "smooth" });
      invalid.focus({ preventScroll: true });
    });
  }

  async function submit(resetAfter: boolean) {
    const nextErrors = validateInspectionValues(values, { daysOnBoard: true });
    const nextDateError = date ? "" : "Choose the inspection date";
    setErrors(nextErrors);
    setDateError(nextDateError);
    if (nextDateError || Object.keys(nextErrors).length > 0) {
      focusFirstError();
      return;
    }
    const payload = toInspectionPayload(date, inspectorName, values);
    const counts = miteRows(values);
    setSubmitting(true);
    try {
      if (isEdit && inspection) {
        await updateInspection.mutateAsync({ id: inspection.id, ...payload });
        // The whole final mite-count set lands in ONE transactional request;
        // a per-row sequence could fail halfway and persist a partial edit.
        await replaceMiteCounts.mutateAsync({
          inspectionId: inspection.id,
          hiveId,
          counts,
        });
        toast.success("Inspection updated");
      } else {
        await createInspection.mutateAsync({ hiveId, ...payload, miteCounts: counts });
        toast.success("Inspection saved");
      }
      if (resetAfter && !isEdit) {
        const fresh = emptyInspectionValues();
        setValues(fresh);
        setErrors({});
        setBaseline(JSON.stringify([date, inspectorName, fresh]));
        setRound((value) => value + 1);
        requestAnimationFrame(() => dateRef.current?.focus());
      } else {
        onClose();
      }
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not save the inspection",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <ShortcutForm
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
        onSubmitAndReset={() => submit(true)}
        onEscape={requestClose}
        className="grid gap-5"
        noValidate
      >
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="inspection-date">Date</Label>
            <Input
              ref={dateRef}
              id="inspection-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              aria-invalid={dateError ? true : undefined}
              aria-describedby={dateError ? "inspection-date-error" : undefined}
            />
            {dateError ? (
              <p id="inspection-date-error" className="text-sm text-destructive" role="alert">
                {dateError}
              </p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="inspection-inspector">Inspected by</Label>
            <Input
              id="inspection-inspector"
              value={inspectorName}
              onChange={(event) => setInspectorName(event.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>

        <InspectionFields
          key={round}
          idPrefix="inspection"
          value={values}
          onChange={setValues}
          errors={errors}
          disabled={submitting}
          include={{ daysOnBoard: true }}
        />

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={requestClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : isEdit ? "Save changes" : "Save inspection"}
          </Button>
        </DialogFooter>
      </ShortcutForm>
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this inspection?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Closing throws them away; nothing is
              recorded until you save.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setDiscardOpen(false);
                onClose();
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
