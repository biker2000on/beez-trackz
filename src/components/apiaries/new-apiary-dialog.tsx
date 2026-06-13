"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createApiary } from "@/actions/apiaries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useShortcut } from "@/components/keyboard/shortcut-provider";
import { Plus, LocateFixed, Loader2 } from "lucide-react";

export function NewApiaryDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(createApiary, null);
  const result = state as { error?: string; success?: boolean } | null;

  const [name, setName] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [notes, setNotes] = useState("");
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  useShortcut("n", "New apiary", "Apiaries", () => setOpen(true));

  // Close + refresh the list when the action reports success.
  useEffect(() => {
    if (result?.success) {
      setName("");
      setLatitude("");
      setLongitude("");
      setNotes("");
      setGeoError(null);
      setOpen(false);
      router.refresh();
    }
  }, [result, router]);

  const useCurrentLocation = () => {
    if (!("geolocation" in navigator)) {
      setGeoError("Location isn't available on this device.");
      return;
    }
    setGeoError(null);
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLatitude(pos.coords.latitude.toFixed(6));
        setLongitude(pos.coords.longitude.toFixed(6));
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied. Enable it in your browser settings."
            : err.code === err.TIMEOUT
              ? "Timed out getting your location. Try again."
              : "Couldn't get your location."
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
          New Apiary
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New Apiary</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          {result?.error && (
            <p className="text-destructive text-sm">{result.error}</p>
          )}
          <div className="space-y-2">
            <Label htmlFor="apiary-name">Name *</Label>
            <Input
              id="apiary-name"
              name="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Location</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                onClick={useCurrentLocation}
                disabled={locating}
              >
                {locating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LocateFixed className="h-3.5 w-3.5" />
                )}
                {locating ? "Locating…" : "Use current location"}
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="apiary-lat" className="text-xs text-muted-foreground">
                  Latitude
                </Label>
                <Input
                  id="apiary-lat"
                  name="latitude"
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={latitude}
                  onChange={(e) => setLatitude(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="apiary-lng" className="text-xs text-muted-foreground">
                  Longitude
                </Label>
                <Input
                  id="apiary-lng"
                  name="longitude"
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={longitude}
                  onChange={(e) => setLongitude(e.target.value)}
                />
              </div>
            </div>
            {geoError && <p className="text-destructive text-xs">{geoError}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="apiary-notes">Notes</Label>
            <Textarea
              id="apiary-notes"
              name="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving…" : "Create Apiary"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
