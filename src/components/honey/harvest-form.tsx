"use client";

import { useState } from "react";
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
import { useRestoreOnError } from "@/components/forms/use-restore-on-error";
import { useRef } from "react";

interface HarvestFormProps {
  action: (prevState: unknown, formData: FormData) => Promise<unknown>;
  hives: { id: string; label: string }[];
  title: string;
  submitLabel: string;
}

export function HarvestForm({
  action,
  hives,
  title,
  submitLabel,
}: HarvestFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const formRef = useRef<HTMLFormElement>(null);
  useRestoreOnError(
    formRef,
    (state as { values?: Record<string, string> } | null)?.values
  );
  const [weightBefore, setWeightBefore] = useState("");
  const [weightAfter, setWeightAfter] = useState("");

  const errorMessage =
    state && typeof state === "object" && "error" in state
      ? (state as { error: string }).error
      : null;

  const dateValue = new Date().toISOString().split("T")[0];

  const before = parseFloat(weightBefore) || 0;
  const after = parseFloat(weightAfter) || 0;
  const honeyWeight = before > after ? before - after : 0;

  return (
    <Card className="max-w-2xl mx-auto">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {errorMessage && (
          <p className="text-destructive text-sm mb-4">{errorMessage}</p>
        )}
        <form ref={formRef} action={formAction} className="space-y-6">
          {/* Hive & Date */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="hiveId">Hive *</Label>
              <Select name="hiveId" required>
                <SelectTrigger>
                  <SelectValue placeholder="Select hive" />
                </SelectTrigger>
                <SelectContent>
                  {hives.map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="date">Date *</Label>
              <Input
                id="date"
                name="date"
                type="date"
                required
                defaultValue={dateValue}
              />
            </div>
          </div>

          {/* Weights */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="superWeightBefore">Super Weight Before (lbs) *</Label>
              <Input
                id="superWeightBefore"
                name="superWeightBefore"
                type="number"
                step="0.1"
                min="0"
                required
                placeholder="e.g. 45.0"
                value={weightBefore}
                onChange={(e) => setWeightBefore(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="superWeightAfter">Super Weight After (lbs) *</Label>
              <Input
                id="superWeightAfter"
                name="superWeightAfter"
                type="number"
                step="0.1"
                min="0"
                required
                placeholder="e.g. 20.0"
                value={weightAfter}
                onChange={(e) => setWeightAfter(e.target.value)}
              />
            </div>
          </div>

          {/* Calculated honey weight */}
          {(weightBefore || weightAfter) && (
            <div className="rounded-md bg-muted px-4 py-3 text-sm">
              Estimated honey yield:{" "}
              <span className="font-semibold">{honeyWeight.toFixed(1)} lbs</span>
            </div>
          )}

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              name="notes"
              rows={3}
              placeholder="Additional notes about this harvest..."
            />
          </div>

          <Button type="submit" disabled={isPending} className="w-full">
            {isPending ? "Saving..." : submitLabel}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
