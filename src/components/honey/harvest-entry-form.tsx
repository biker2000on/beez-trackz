"use client";

import { useServerActionForm } from "@/components/forms/use-server-action-form";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRestoreOnError } from "@/components/forms/use-restore-on-error";
import { useRef } from "react";

interface HarvestEntryFormProps {
  action: (prevState: unknown, formData: FormData) => Promise<{ error?: string; success?: boolean } | void>;
  hives: { id: string; positionLabel: string }[];
}

export function HarvestEntryForm({ action, hives }: HarvestEntryFormProps) {
  const [state, formAction, isPending] = useServerActionForm(action, null);
  const formRef = useRef<HTMLFormElement>(null);
  useRestoreOnError(
    formRef,
    (state as { values?: Record<string, string> } | null)?.values
  );
  const [weightBefore, setWeightBefore] = useState<number>(0);
  const [weightAfter, setWeightAfter] = useState<number>(0);

  const honeyWeight = weightBefore - weightAfter;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add Harvest Entry</CardTitle>
      </CardHeader>
      <CardContent>
        <form ref={formRef} onSubmit={formAction} className="space-y-4">
          {state?.error && (
            <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive">
              {state.error}
            </div>
          )}

          {state?.success && (
            <div className="rounded-md bg-green-500/15 p-3 text-sm text-green-700">
              Entry added successfully!
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="hiveId">Hive</Label>
            <Select name="hiveId" required>
              <SelectTrigger id="hiveId">
                <SelectValue placeholder="Select hive" />
              </SelectTrigger>
              <SelectContent>
                {hives.map((hive) => (
                  <SelectItem key={hive.id} value={hive.id}>
                    {hive.positionLabel}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="superWeightBefore">Weight Before (lbs)</Label>
              <Input
                type="number"
                step="0.1"
                id="superWeightBefore"
                name="superWeightBefore"
                required
                onChange={(e) => setWeightBefore(parseFloat(e.target.value) || 0)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="superWeightAfter">Weight After (lbs)</Label>
              <Input
                type="number"
                step="0.1"
                id="superWeightAfter"
                name="superWeightAfter"
                required
                onChange={(e) => setWeightAfter(parseFloat(e.target.value) || 0)}
              />
            </div>
          </div>

          {honeyWeight > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Calculated honey weight:</span>
              <Badge variant="secondary">{honeyWeight.toFixed(1)} lbs</Badge>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Textarea
              id="notes"
              name="notes"
              placeholder="Notes about this entry..."
              rows={2}
            />
          </div>

          <Button type="submit" disabled={isPending}>
            {isPending ? "Adding..." : "Add Entry"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
