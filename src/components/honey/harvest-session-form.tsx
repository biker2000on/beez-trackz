"use client";

import { useServerActionForm } from "@/components/forms/use-server-action-form";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRestoreOnError } from "@/components/forms/use-restore-on-error";
import { useRef } from "react";

interface HarvestSessionFormProps {
  action: (prevState: unknown, formData: FormData) => Promise<{ error?: string } | void>;
  apiaries: { id: string; name: string }[];
}

export function HarvestSessionForm({ action, apiaries }: HarvestSessionFormProps) {
  const [state, formAction, isPending] = useServerActionForm(action, null);
  const formRef = useRef<HTMLFormElement>(null);
  useRestoreOnError(
    formRef,
    (state as { values?: Record<string, string> } | null)?.values
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>New Harvest Session</CardTitle>
      </CardHeader>
      <CardContent>
        <form ref={formRef} onSubmit={formAction} className="space-y-4">
          {state?.error && (
            <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive">
              {state.error}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="apiaryId">Apiary</Label>
            <Select name="apiaryId" required>
              <SelectTrigger id="apiaryId">
                <SelectValue placeholder="Select apiary" />
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

          <div className="space-y-2">
            <Label htmlFor="date">Harvest Date</Label>
            <Input
              type="date"
              id="date"
              name="date"
              required
              defaultValue={new Date().toISOString().split("T")[0]}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Textarea
              id="notes"
              name="notes"
              placeholder="Notes about this harvest session..."
              rows={3}
            />
          </div>

          <Button type="submit" disabled={isPending}>
            {isPending ? "Creating..." : "Create Session"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
