"use client";

import { useServerActionForm } from "@/components/forms/use-server-action-form";

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

interface SplitHiveFormProps {
  action: (prevState: unknown, formData: FormData) => Promise<unknown>;
  parentHiveId: string;
  apiaryId: string;
  apiaries: { id: string; name: string }[];
  embedded?: boolean;
}

const SPLIT_TYPE_OPTIONS = [
  { value: "walk-away", label: "Walk-Away Split" },
  { value: "vertical", label: "Vertical Split" },
  { value: "nuc", label: "Nuc Split" },
  { value: "cutdown", label: "Cutdown" },
  { value: "other", label: "Other" },
];

export function SplitHiveForm({
  action,
  parentHiveId,
  apiaryId,
  apiaries,
  embedded = false,
}: SplitHiveFormProps) {
  const [state, formAction, isPending] = useServerActionForm(action, null);
  const formRef = useRef<HTMLFormElement>(null);
  useRestoreOnError(
    formRef,
    (state as { values?: Record<string, string> } | null)?.values
  );
  const errorMessage =
    state && typeof state === "object" && "error" in state
      ? (state as { error: string }).error
      : null;

  const dateValue = new Date().toISOString().split("T")[0];

  const content = (
    <>
      {!embedded && (
      <CardHeader>
        <CardTitle>Split Hive</CardTitle>
      </CardHeader>
      )}
      <CardContent>
        {errorMessage && (
          <p className="text-destructive text-sm mb-4">{errorMessage}</p>
        )}
        <form ref={formRef} onSubmit={formAction} className="space-y-6">
          <input type="hidden" name="parentHiveId" value={parentHiveId} />

          {/* Apiary & Position */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="apiaryId">Apiary *</Label>
              <Select name="apiaryId" required defaultValue={apiaryId}>
                <SelectTrigger>
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
              <Label htmlFor="positionLabel">Position Label *</Label>
              <Input
                id="positionLabel"
                name="positionLabel"
                type="text"
                required
                placeholder="e.g. H5"
              />
            </div>
          </div>

          {/* Split Date & Type */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="splitDate">Split Date *</Label>
              <Input
                id="splitDate"
                name="splitDate"
                type="date"
                required
                defaultValue={dateValue}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="splitType">Split Type *</Label>
              <Select name="splitType" required>
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {SPLIT_TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Frames Moved */}
          <div className="space-y-2">
            <Label htmlFor="framesMoved">Frames Moved (optional)</Label>
            <Input
              id="framesMoved"
              name="framesMoved"
              type="number"
              min="0"
              placeholder="Number of frames moved to new hive"
            />
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              name="notes"
              rows={3}
              placeholder="Additional notes about this split..."
            />
          </div>

          <Button type="submit" disabled={isPending} className="w-full">
            {isPending ? "Creating Split..." : "Create Split"}
          </Button>
        </form>
      </CardContent>
    </>
  );

  if (embedded) {
    return <div>{content}</div>;
  }

  return (
    <Card className="max-w-2xl mx-auto">
      {content}
    </Card>
  );
}
