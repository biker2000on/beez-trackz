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

interface FeedingFormProps {
  action: (prevState: unknown, formData: FormData) => Promise<unknown>;
  hiveId: string;
  title: string;
  submitLabel: string;
  embedded?: boolean;
}

const FEED_TYPE_OPTIONS = [
  { value: "sugar_syrup_1to1", label: "Sugar Syrup 1:1" },
  { value: "sugar_syrup_2to1", label: "Sugar Syrup 2:1" },
  { value: "dry_sugar", label: "Dry Sugar" },
  { value: "pollen_patty", label: "Pollen Patty" },
  { value: "fondant", label: "Fondant" },
  { value: "other", label: "Other" },
];

const UNIT_OPTIONS = [
  { value: "lbs", label: "lbs" },
  { value: "oz", label: "oz" },
  { value: "quarts", label: "quarts" },
  { value: "gallons", label: "gallons" },
];

const FEEDER_TYPE_OPTIONS = [
  { value: "entrance", label: "Entrance" },
  { value: "top", label: "Top" },
  { value: "frame", label: "Frame" },
  { value: "baggie", label: "Baggie" },
  { value: "open", label: "Open" },
  { value: "other", label: "Other" },
];

export function FeedingForm({
  action,
  hiveId,
  title,
  submitLabel,
  embedded = false,
}: FeedingFormProps) {
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
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      )}
      <CardContent>
        {errorMessage && (
          <p className="text-destructive text-sm mb-4">{errorMessage}</p>
        )}
        <form ref={formRef} onSubmit={formAction} className="space-y-6">
          <input type="hidden" name="hiveId" value={hiveId} />

          {/* Date & Feed Type */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="dateFed">Date Fed *</Label>
              <Input
                id="dateFed"
                name="dateFed"
                type="date"
                required
                defaultValue={dateValue}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="type">Feed Type *</Label>
              <Select name="type" required>
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {FEED_TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Quantity & Unit */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="quantity">Quantity *</Label>
              <Input
                id="quantity"
                name="quantity"
                type="number"
                step="0.1"
                min="0"
                required
                placeholder="e.g. 2.5"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="quantityUnit">Unit *</Label>
              <Select name="quantityUnit" required defaultValue="lbs">
                <SelectTrigger>
                  <SelectValue placeholder="Select unit" />
                </SelectTrigger>
                <SelectContent>
                  {UNIT_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Feeder Type */}
          <div className="space-y-2">
            <Label htmlFor="feederType">Feeder Type</Label>
            <Select name="feederType">
              <SelectTrigger>
                <SelectValue placeholder="Select feeder (optional)" />
              </SelectTrigger>
              <SelectContent>
                {FEEDER_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              name="notes"
              rows={3}
              placeholder="Additional notes about this feeding..."
            />
          </div>

          <Button type="submit" disabled={isPending} className="w-full">
            {isPending ? "Saving..." : submitLabel}
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
