"use client";

import { useActionState, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useRestoreOnError } from "@/components/forms/use-restore-on-error";
import { LocateFixed, Loader2 } from "lucide-react";

interface ApiaryFormProps {
  action: (prevState: unknown, formData: FormData) => Promise<unknown>;
  defaultValues?: {
    name?: string;
    latitude?: number | null;
    longitude?: number | null;
    notes?: string | null;
  };
  title: string;
  submitLabel: string;
}

export function ApiaryForm({
  action,
  defaultValues,
  title,
  submitLabel,
}: ApiaryFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const result = state as { error?: string; values?: Record<string, string> } | null;
  const errorMessage = result?.error ?? null;
  const formRef = useRef<HTMLFormElement>(null);
  useRestoreOnError(formRef, result?.values);

  // Lat/lng are controlled so the "current location" button can fill them.
  // (Controlled inputs also survive React's post-action form reset on their
  // own, so they don't need the restore hook.)
  const [latitude, setLatitude] = useState(
    defaultValues?.latitude != null ? String(defaultValues.latitude) : ""
  );
  const [longitude, setLongitude] = useState(
    defaultValues?.longitude != null ? String(defaultValues.longitude) : ""
  );
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  const useCurrentLocation = () => {
    if (!("geolocation" in navigator)) {
      setGeoError("Location isn't available on this device.");
      return;
    }
    setGeoError(null);
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // ~6 decimals ≈ 0.1 m, plenty for an apiary pin.
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
    <Card className="max-w-lg mx-auto">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {errorMessage && (
          <p className="text-destructive text-sm mb-4">{errorMessage}</p>
        )}
        <form ref={formRef} action={formAction} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name *</Label>
            <Input id="name" name="name" required defaultValue={defaultValues?.name} />
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
                <Label htmlFor="latitude" className="text-xs text-muted-foreground">
                  Latitude
                </Label>
                <Input
                  id="latitude"
                  name="latitude"
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={latitude}
                  onChange={(e) => setLatitude(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="longitude" className="text-xs text-muted-foreground">
                  Longitude
                </Label>
                <Input
                  id="longitude"
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
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" defaultValue={defaultValues?.notes ?? ""} />
          </div>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving..." : submitLabel}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
