"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
import { useCreateSplit, type Hive } from "./hooks";
import { todayInput } from "./lib";

const SPLIT_TYPES = [
  ["walk-away", "Walk-away split"],
  ["vertical", "Vertical split"],
  ["nuc", "Nuc split"],
  ["cutdown", "Cutdown split"],
  ["other", "Other"],
] as const;

const splitSchema = z.object({
  apiaryId: z.string().min(1, "Apiary is required"),
  positionLabel: z.string().trim().min(1, "Position label is required"),
  splitDate: z.string().min(1, "Date is required"),
  splitType: z.string().min(1, "Split type is required"),
  framesMoved: z
    .string()
    .trim()
    .refine(
      (value) =>
        value === "" || (Number.isInteger(Number(value)) && Number(value) >= 0),
      { message: "Frames must be a whole number" },
    ),
  notes: z.string(),
});

type SplitValues = z.infer<typeof splitSchema>;

export function SplitDialog({
  open,
  onOpenChange,
  hive,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hive: Hive;
}) {
  const router = useRouter();
  const apiaries = useApiaries();
  const createSplit = useCreateSplit();

  const form = useForm<SplitValues>({
    resolver: zodResolver(splitSchema),
    defaultValues: {
      apiaryId: hive.apiaryId,
      positionLabel: "",
      splitDate: todayInput(),
      splitType: "walk-away",
      framesMoved: "",
      notes: "",
    },
  });

  React.useEffect(() => {
    if (open) {
      form.reset({
        apiaryId: hive.apiaryId,
        positionLabel: "",
        splitDate: todayInput(),
        splitType: "walk-away",
        framesMoved: "",
        notes: "",
      });
    }
  }, [open, hive.apiaryId, form]);

  const watched = form.watch();

  async function onSubmit(values: SplitValues, resetAfter = false) {
    try {
      const result = await createSplit.mutateAsync({
        parentHiveId: hive.id,
        apiaryId: values.apiaryId,
        positionLabel: values.positionLabel,
        splitDate: values.splitDate,
        splitType: values.splitType,
        framesMoved:
          values.framesMoved === "" ? null : Number(values.framesMoved),
        notes: values.notes.trim() === "" ? null : values.notes,
      });
      toast.success("Split recorded — new hive created");
      if (resetAfter) {
        form.reset({
          apiaryId: hive.apiaryId,
          positionLabel: "",
          splitDate: todayInput(),
          splitType: "walk-away",
          framesMoved: "",
          notes: "",
        });
        requestAnimationFrame(() => form.setFocus("positionLabel"));
      } else {
        onOpenChange(false);
        router.push(`/hives/${result.id}`);
      }
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not record the split",
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Split {hive.positionLabel}</DialogTitle>
          <DialogDescription>
            Creates a new child hive linked back to this one.
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
            <Label>New hive apiary</Label>
            <Select
              value={watched.apiaryId}
              onValueChange={(value) =>
                form.setValue("apiaryId", value, { shouldValidate: true })
              }
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
          </div>
          <div className="grid gap-2">
            <Label htmlFor="split-label">New hive position label</Label>
            <Input
              id="split-label"
              placeholder="e.g. B2-1"
              aria-invalid={
                form.formState.errors.positionLabel ? true : undefined
              }
              {...form.register("positionLabel")}
            />
            {form.formState.errors.positionLabel && (
              <p className="text-sm text-destructive" role="alert">
                {form.formState.errors.positionLabel.message}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="split-date">Split date</Label>
              <Input
                id="split-date"
                type="date"
                aria-invalid={
                  form.formState.errors.splitDate ? true : undefined
                }
                {...form.register("splitDate")}
              />
            </div>
            <div className="grid gap-2">
              <Label>Split type</Label>
              <Select
                value={watched.splitType}
                onValueChange={(value) => form.setValue("splitType", value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SPLIT_TYPES.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="split-frames">Frames moved</Label>
            <Input
              id="split-frames"
              inputMode="numeric"
              placeholder="Optional"
              aria-invalid={
                form.formState.errors.framesMoved ? true : undefined
              }
              {...form.register("framesMoved")}
            />
            {form.formState.errors.framesMoved && (
              <p className="text-sm text-destructive" role="alert">
                {form.formState.errors.framesMoved.message}
              </p>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="split-notes">Notes</Label>
            <Textarea id="split-notes" rows={2} {...form.register("notes")} />
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
              {form.formState.isSubmitting ? "Splitting…" : "Record split"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}
