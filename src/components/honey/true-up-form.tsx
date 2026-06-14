"use client";

import { useServerActionForm } from "@/components/forms/use-server-action-form";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useRestoreOnError } from "@/components/forms/use-restore-on-error";
import { useRef } from "react";

interface TrueUpFormProps {
  action: (prevState: unknown, formData: FormData) => Promise<{ error?: string } | void>;
  currentTotal: number;
  currentTrueUp: number | null;
}

export function TrueUpForm({ action, currentTotal, currentTrueUp }: TrueUpFormProps) {
  const [state, formAction, isPending] = useServerActionForm(action, null);
  const formRef = useRef<HTMLFormElement>(null);
  useRestoreOnError(
    formRef,
    (state as { values?: Record<string, string> } | null)?.values
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>True-Up Total Weight</CardTitle>
      </CardHeader>
      <CardContent>
        <form ref={formRef} onSubmit={formAction} className="space-y-4">
          {state?.error && (
            <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive">
              {state.error}
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Calculated sum from entries:</span>
            <Badge variant="secondary">{currentTotal.toFixed(1)} lbs</Badge>
          </div>

          {currentTrueUp !== null && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Current actual weight:</span>
              <Badge>{currentTrueUp.toFixed(1)} lbs</Badge>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="totalExtractedWeight">Actual Extracted Weight (lbs)</Label>
            <Input
              type="number"
              step="0.1"
              id="totalExtractedWeight"
              name="totalExtractedWeight"
              required
              placeholder="Enter total weight after extraction"
              defaultValue={currentTrueUp?.toString() || ""}
            />
          </div>

          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving..." : "Save True-Up"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
