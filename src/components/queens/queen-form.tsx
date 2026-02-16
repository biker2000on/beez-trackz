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

interface QueenFormProps {
  action: (prevState: unknown, formData: FormData) => Promise<unknown>;
  defaultValues?: {
    hiveId?: string | null;
    origin?: string;
    originHiveId?: string | null;
    parentQueenId?: string | null;
    introducedDate?: Date | null;
    status?: string;
    notes?: string | null;
  };
  hives: { id: string; name: string }[];
  queens: { id: string; label: string }[];
  title: string;
  submitLabel: string;
}

const ORIGIN_OPTIONS = [
  { value: "purchased", label: "Purchased" },
  { value: "swarm", label: "Swarm" },
  { value: "raised", label: "Raised" },
  { value: "walked", label: "Walk-away Split" },
  { value: "emergency_cell", label: "Emergency Cell" },
  { value: "unknown", label: "Unknown" },
];

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "superseded", label: "Superseded" },
  { value: "dead", label: "Dead" },
  { value: "missing", label: "Missing" },
];

export function QueenForm({
  action,
  defaultValues,
  hives,
  queens,
  title,
  submitLabel,
}: QueenFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const errorMessage =
    state && typeof state === "object" && "error" in state
      ? (state as { error: string }).error
      : null;

  const introducedDateValue = defaultValues?.introducedDate
    ? new Date(defaultValues.introducedDate).toISOString().split("T")[0]
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
          <div className="space-y-2">
            <Label htmlFor="hiveId">Hive</Label>
            <Select
              name="hiveId"
              defaultValue={defaultValues?.hiveId ?? "__none__"}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a hive (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {hives.map((hive) => (
                  <SelectItem key={hive.id} value={hive.id}>
                    {hive.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="origin">Origin *</Label>
            <Select
              name="origin"
              defaultValue={defaultValues?.origin || "unknown"}
              required
            >
              <SelectTrigger>
                <SelectValue placeholder="Select origin" />
              </SelectTrigger>
              <SelectContent>
                {ORIGIN_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="originHiveId">Origin Hive</Label>
            <Select
              name="originHiveId"
              defaultValue={defaultValues?.originHiveId ?? "__none__"}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select origin hive (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {hives.map((hive) => (
                  <SelectItem key={hive.id} value={hive.id}>
                    {hive.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="parentQueenId">Parent Queen</Label>
            <Select
              name="parentQueenId"
              defaultValue={defaultValues?.parentQueenId ?? "__none__"}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select parent queen (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {queens.map((queen) => (
                  <SelectItem key={queen.id} value={queen.id}>
                    {queen.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="introducedDate">Introduced Date</Label>
            <Input
              id="introducedDate"
              name="introducedDate"
              type="date"
              defaultValue={introducedDateValue}
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
                {STATUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
