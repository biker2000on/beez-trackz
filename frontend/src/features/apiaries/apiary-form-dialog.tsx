"use client";

import * as React from "react";
import dynamic from "next/dynamic";
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
import { Textarea } from "@/components/ui/textarea";
import type { LocationValue } from "@/features/map/location-picker";
import {
  clampForageRadius,
  FORAGE_RADIUS_DEFAULT_M,
} from "@/features/map/forage-radius";
import {
  type Apiary,
  type ApiaryListItem,
  useCreateApiary,
  useUpdateApiary,
} from "./hooks";

const LocationPicker = dynamic(
  () =>
    import("@/features/map/location-picker").then((mod) => mod.LocationPicker),
  { ssr: false },
);

const apiarySchema = z.object({
  name: z.string().trim().min(1, "Apiary name is required"),
  notes: z.string(),
});

type ApiaryValues = z.infer<typeof apiarySchema>;

function toLocation(apiary?: Apiary | ApiaryListItem | null): LocationValue {
  const source = apiary?.elevationSource;
  return {
    latitude: apiary?.latitude ?? null,
    longitude: apiary?.longitude ?? null,
    elevationM: apiary?.elevationM ?? null,
    elevationSource:
      source === "geolocation" || source === "terrain" || source === "override"
        ? source
        : null,
    forageRadiusM: apiary
      ? clampForageRadius(apiary.forageRadiusM)
      : FORAGE_RADIUS_DEFAULT_M,
  };
}

export function ApiaryFormDialog({
  open,
  onOpenChange,
  apiary,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog edits this apiary; otherwise it creates one. */
  apiary?: Apiary | ApiaryListItem | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {open ? (
          <ApiaryFormBody
            key={apiary?.id ?? "new"}
            apiary={apiary}
            onOpenChange={onOpenChange}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ApiaryFormBody({
  apiary,
  onOpenChange,
}: {
  apiary?: Apiary | ApiaryListItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const isEdit = Boolean(apiary);
  const createApiary = useCreateApiary();
  const updateApiary = useUpdateApiary(apiary?.id ?? "");
  const [location, setLocation] = React.useState<LocationValue>(() =>
    toLocation(apiary),
  );

  const form = useForm<ApiaryValues>({
    resolver: zodResolver(apiarySchema),
    defaultValues: { name: apiary?.name ?? "", notes: apiary?.notes ?? "" },
  });

  async function onSubmit(values: ApiaryValues, resetAfter = false) {
    const payload = {
      name: values.name,
      latitude: location.latitude,
      longitude: location.longitude,
      elevationM: location.elevationM,
      elevationSource: location.elevationSource,
      forageRadiusM: location.forageRadiusM,
      notes: values.notes.trim() === "" ? null : values.notes,
    };
    try {
      if (isEdit) {
        await updateApiary.mutateAsync(payload);
        toast.success("Apiary updated");
      } else {
        await createApiary.mutateAsync(payload);
        toast.success("Apiary created");
      }
      if (resetAfter && !isEdit) {
        form.reset({ name: "", notes: "" });
        setLocation({
          latitude: null,
          longitude: null,
          elevationM: null,
          elevationSource: null,
          forageRadiusM: FORAGE_RADIUS_DEFAULT_M,
        });
      } else onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not save the apiary",
      );
    }
  }

  return (
        <>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit apiary" : "New apiary"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update this apiary's details."
              : "Add a location where your hives live."}
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
            <Label htmlFor="apiary-name">Name</Label>
            <Input
              id="apiary-name"
              placeholder="e.g. Home Yard"
              autoFocus
              aria-invalid={form.formState.errors.name ? true : undefined}
              {...form.register("name")}
            />
            {form.formState.errors.name && (
              <p className="text-sm text-destructive" role="alert">
                {form.formState.errors.name.message}
              </p>
            )}
          </div>
          <LocationPicker value={location} onChange={setLocation} />
          <div className="grid gap-2">
            <Label htmlFor="apiary-notes">Notes</Label>
            <Textarea
              id="apiary-notes"
              rows={3}
              placeholder="Access notes, landowner details…"
              {...form.register("notes")}
            />
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
                  : "Create apiary"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
        </>
  );
}
