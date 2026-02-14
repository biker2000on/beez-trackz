"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
  const errorMessage =
    state && typeof state === "object" && "error" in state
      ? (state as { error: string }).error
      : null;

  return (
    <Card className="max-w-lg mx-auto">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {errorMessage && (
          <p className="text-destructive text-sm mb-4">{errorMessage}</p>
        )}
        <form action={formAction} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              name="name"
              required
              defaultValue={defaultValues?.name}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="latitude">Latitude</Label>
              <Input
                id="latitude"
                name="latitude"
                type="number"
                step="any"
                defaultValue={defaultValues?.latitude ?? ""}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="longitude">Longitude</Label>
              <Input
                id="longitude"
                name="longitude"
                type="number"
                step="any"
                defaultValue={defaultValues?.longitude ?? ""}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              name="notes"
              defaultValue={defaultValues?.notes ?? ""}
            />
          </div>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving..." : submitLabel}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
