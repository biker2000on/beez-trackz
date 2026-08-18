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
}

export function SetLocationDialog({
  apiaryId,
  name,
  notes,
  value,
  onOpenChange,
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
      await update.mutateAsync(payload);
      toast.success(
        draft.latitude != null
          ? "Yard location saved"
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
            Drop a pin so the canvas can sit on real imagery and the sun model
            has a place to work from. No pin means no map and no sun.
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
