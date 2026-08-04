"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { LocateFixed } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  type Apiary,
  type ApiaryListItem,
  useCreateApiary,
  useUpdateApiary,
} from "./hooks";

const coordinate = (min: number, max: number) =>
  z
    .string()
    .trim()
    .refine(
      (value) => {
        if (value === "") return true;
        const n = Number(value);
        return Number.isFinite(n) && n >= min && n <= max;
      },
      { message: `Must be a number between ${min} and ${max}` },
    );

const apiarySchema = z.object({
  name: z.string().trim().min(1, "Apiary name is required"),
  latitude: coordinate(-90, 90),
  longitude: coordinate(-180, 180),
  notes: z.string(),
});

type ApiaryValues = z.infer<typeof apiarySchema>;

function toValues(apiary?: Apiary | ApiaryListItem | null): ApiaryValues {
  return {
    name: apiary?.name ?? "",
    latitude: apiary?.latitude != null ? String(apiary.latitude) : "",
    longitude: apiary?.longitude != null ? String(apiary.longitude) : "",
    notes: apiary?.notes ?? "",
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
  const isEdit = Boolean(apiary);
  const createApiary = useCreateApiary();
  const updateApiary = useUpdateApiary(apiary?.id ?? "");
  const [locating, setLocating] = React.useState(false);

  const form = useForm<ApiaryValues>({
    resolver: zodResolver(apiarySchema),
    defaultValues: toValues(apiary),
  });

  React.useEffect(() => {
    if (open) form.reset(toValues(apiary));
  }, [open, apiary, form]);

  function useCurrentLocation() {
    if (!("geolocation" in navigator)) {
      toast.error("Geolocation is not supported by this browser.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        form.setValue("latitude", position.coords.latitude.toFixed(6), {
          shouldValidate: true,
        });
        form.setValue("longitude", position.coords.longitude.toFixed(6), {
          shouldValidate: true,
        });
      },
      (error) => {
        setLocating(false);
        if (error.code === error.PERMISSION_DENIED) {
          toast.error(
            "Location permission denied. Enter coordinates manually.",
          );
        } else if (error.code === error.TIMEOUT) {
          toast.error("Timed out getting your location. Try again.");
        } else {
          toast.error("Could not determine your location.");
        }
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  async function onSubmit(values: ApiaryValues) {
    const payload = {
      name: values.name,
      latitude: values.latitude === "" ? null : Number(values.latitude),
      longitude: values.longitude === "" ? null : Number(values.longitude),
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
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not save the apiary",
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit apiary" : "New apiary"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update this apiary's details."
              : "Add a location where your hives live."}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
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
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="apiary-lat">Latitude</Label>
              <Input
                id="apiary-lat"
                inputMode="decimal"
                placeholder="e.g. 39.7392"
                aria-invalid={form.formState.errors.latitude ? true : undefined}
                {...form.register("latitude")}
              />
              {form.formState.errors.latitude && (
                <p className="text-sm text-destructive" role="alert">
                  {form.formState.errors.latitude.message}
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="apiary-lng">Longitude</Label>
              <Input
                id="apiary-lng"
                inputMode="decimal"
                placeholder="e.g. -104.9903"
                aria-invalid={
                  form.formState.errors.longitude ? true : undefined
                }
                {...form.register("longitude")}
              />
              {form.formState.errors.longitude && (
                <p className="text-sm text-destructive" role="alert">
                  {form.formState.errors.longitude.message}
                </p>
              )}
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-self-start"
            onClick={useCurrentLocation}
            disabled={locating}
          >
            <LocateFixed className="size-4" />
            {locating ? "Locating…" : "Use current location"}
          </Button>
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
        </form>
      </DialogContent>
    </Dialog>
  );
}
