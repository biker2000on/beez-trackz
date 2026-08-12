"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
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

import {
  QUEEN_ORIGINS,
  QUEEN_ORIGIN_LABELS,
  QUEEN_STATUSES,
  QUEEN_STATUS_LABELS,
  useCreateQueen,
  useHiveOptions,
  useUpdateQueen,
  type Queen,
  type QueenPayload,
} from "./api";
import { markingColorForDate } from "./marking";

/** Radix selects can't hold an empty value; NONE maps to null in the payload. */
const NONE = "none";

const queenSchema = z.object({
  hiveId: z.string(),
  parentQueenId: z.string(),
  origin: z.enum(QUEEN_ORIGINS),
  introducedDate: z.string(),
  status: z.enum(QUEEN_STATUSES),
  notes: z.string(),
});

type QueenFormValues = z.infer<typeof queenSchema>;

function toFormValues(queen?: Queen): QueenFormValues {
  return {
    hiveId: queen?.hiveId ?? NONE,
    parentQueenId: queen?.parentQueenId ?? NONE,
    origin: queen?.origin ?? "purchased",
    introducedDate: queen?.introducedDate?.slice(0, 10) ?? "",
    status: queen?.status ?? "active",
    notes: queen?.notes ?? "",
  };
}

function toPayload(values: QueenFormValues, existing?: Queen): QueenPayload {
  return {
    hiveId: values.hiveId === NONE ? null : values.hiveId,
    parentQueenId: values.parentQueenId === NONE ? null : values.parentQueenId,
    // The API PUT is a full replace and this form has no originHiveId field —
    // carry the stored value through so editing a queen never wipes it.
    originHiveId: existing?.originHiveId ?? null,
    origin: values.origin,
    introducedDate: values.introducedDate || null,
    status: values.status,
    notes: values.notes.trim() || null,
  };
}

function queenOptionLabel(queen: Queen): string {
  const marking = markingColorForDate(queen.introducedDate);
  const year = marking ? `${marking.year}` : "Undated";
  const where = queen.hiveName
    ? `${queen.apiaryName ?? "?"} — ${queen.hiveName}`
    : "not in a hive";
  return `${year} queen (${where})`;
}

export function QueenFormDialog({
  open,
  onOpenChange,
  queen,
  queens,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog edits this queen instead of creating one. */
  queen?: Queen;
  /** All queens, for the parent-queen select. */
  queens: Queen[];
}) {
  const hives = useHiveOptions();
  const createQueen = useCreateQueen();
  const updateQueen = useUpdateQueen();
  const editing = Boolean(queen);

  const form = useForm<QueenFormValues>({
    resolver: zodResolver(queenSchema),
    defaultValues: toFormValues(queen),
  });

  // Re-seed the form each time the dialog opens (fresh create, or the queen
  // being edited changed).
  React.useEffect(() => {
    if (open) form.reset(toFormValues(queen));
  }, [open, queen, form]);

  const parentCandidates = queens.filter((q) => q.id !== queen?.id);

  async function onSubmit(values: QueenFormValues, resetAfter = false) {
    const payload = toPayload(values, queen);
    try {
      if (queen) {
        await updateQueen.mutateAsync({ id: queen.id, ...payload });
        toast.success("Queen updated");
      } else {
        await createQueen.mutateAsync(payload);
        toast.success("Queen added");
      }
      if (resetAfter && !editing) form.reset(toFormValues());
      else onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not save the queen",
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit queen" : "Add queen"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update this queen's hive, lineage, and status."
              : "Record a new queen and link her into the family tree."}
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
            <Label htmlFor="queen-hive">Hive</Label>
            <Controller
              control={form.control}
              name="hiveId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="queen-hive">
                    <SelectValue placeholder="Select a hive" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No hive</SelectItem>
                    {(hives.data ?? []).map((hive) => (
                      <SelectItem key={hive.id} value={hive.id}>
                        {hive.apiaryName} — {hive.positionLabel}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="queen-parent">Parent queen</Label>
            <Controller
              control={form.control}
              name="parentQueenId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="queen-parent">
                    <SelectValue placeholder="Select a parent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No parent (new lineage)</SelectItem>
                    {parentCandidates.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {queenOptionLabel(candidate)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="queen-origin">Origin</Label>
              <Controller
                control={form.control}
                name="origin"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="queen-origin">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {QUEEN_ORIGINS.map((origin) => (
                        <SelectItem key={origin} value={origin}>
                          {QUEEN_ORIGIN_LABELS[origin]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="queen-introduced">Introduced</Label>
              <Input
                id="queen-introduced"
                type="date"
                {...form.register("introducedDate")}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="queen-status">Status</Label>
            <Controller
              control={form.control}
              name="status"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="queen-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {QUEEN_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {QUEEN_STATUS_LABELS[status]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="queen-notes">Notes</Label>
            <Textarea
              id="queen-notes"
              rows={3}
              placeholder="Breeder, temperament, marking…"
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
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting
                ? "Saving…"
                : editing
                  ? "Save changes"
                  : "Add queen"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}
