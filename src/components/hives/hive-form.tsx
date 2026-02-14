"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface HiveFormProps {
  action: (prevState: unknown, formData: FormData) => Promise<unknown>;
  defaultValues?: {
    positionLabel?: string;
    status?: string;
    installedDate?: Date | null;
    notes?: string | null;
    apiaryId?: string;
  };
  apiaries?: { id: string; name: string }[];
  showApiarySelect?: boolean;
  title: string;
  submitLabel: string;
}

export function HiveForm({
  action,
  defaultValues,
  apiaries,
  showApiarySelect = false,
  title,
  submitLabel,
}: HiveFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const errorMessage =
    state && typeof state === "object" && "error" in state
      ? (state as { error: string }).error
      : null;

  const installedDateValue = defaultValues?.installedDate
    ? new Date(defaultValues.installedDate).toISOString().split("T")[0]
    : "";

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
          {showApiarySelect && apiaries && (
            <div className="space-y-2">
              <Label htmlFor="apiaryId">Apiary *</Label>
              <Select
                name="apiaryId"
                defaultValue={defaultValues?.apiaryId || ""}
                required
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select an apiary" />
                </SelectTrigger>
                <SelectContent>
                  {apiaries.map((apiary) => (
                    <SelectItem key={apiary.id} value={apiary.id}>
                      {apiary.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="positionLabel">Position Label *</Label>
            <Input
              id="positionLabel"
              name="positionLabel"
              required
              placeholder="e.g. A1, B2, North-3"
              defaultValue={defaultValues?.positionLabel}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="status">Status</Label>
            <Select
              name="status"
              defaultValue={defaultValues?.status || "active"}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="dead">Dead</SelectItem>
                <SelectItem value="sold">Sold</SelectItem>
                <SelectItem value="combined">Combined</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="installedDate">Installed Date</Label>
            <Input
              id="installedDate"
              name="installedDate"
              type="date"
              defaultValue={installedDateValue}
            />
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
