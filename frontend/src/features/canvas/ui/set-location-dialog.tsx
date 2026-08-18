"use client";

import { useState } from "react";
import { toast } from "sonner";

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
import { ShortcutForm } from "@/components/ui/shortcut-form";
import {
  LocationPicker,
  type LocationValue,
} from "@/features/map/location-picker";
import { useUpdateApiary, type ApiaryPayload } from "@/features/apiaries/hooks";

interface SetLocationDialogProps {
  apiaryId: string;
  name: string;
  notes: string | null;
  value: LocationValue;
  onOpenChange: (open: boolean) => void;
  /** Bake or translate stand GPS before the apiary pin is written. */
  onRelocateStands?: (next: LocationValue) => Promise<void> | void;
}

export function SetLocationDialog({
  apiaryId,
  name,
  notes,
  value,
  onOpenChange,
  onRelocateStands,
}: SetLocationDialogProps) {
  const update = useUpdateApiary(apiaryId);
  const [draft, setDraft] = useState<LocationValue>(value);

  async function onSubmit() {
    const payload: ApiaryPayload = {
      name,
      latitude: draft.latitude,
      longitude: draft.longitude,
      elevationM: draft.elevationM,
      elevationSource: draft.elevationSource,
      notes,
    };
    try {
      await onRelocateStands?.(draft);
      await update.mutateAsync(payload);
      toast.success(
        draft.latitude != null
          ? "Yard location saved — stands keep their GPS relative to the pin"
          : "Location cleared — map and sun stay off until you set a pin",
      );
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not save the location",
      );
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Set yard location</DialogTitle>
          <DialogDescription>
            The pin is the yard. Stands and hives store their own GPS around
            it — moving the pin moves the whole yard. No pin means no map.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          onSubmit={() => void onSubmit()}
          onEscape={() => onOpenChange(false)}
          className="grid gap-4"
        >
          <LocationPicker value={draft} onChange={setDraft} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save location"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}
