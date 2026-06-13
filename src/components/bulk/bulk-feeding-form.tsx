"use client";

import { useState, useActionState } from "react";
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
import { HiveMultiSelector } from "@/components/bulk/hive-multi-selector";
import { CheckCircle } from "lucide-react";
import { bulkCreateFeedings } from "@/actions/bulk";
import { useRestoreOnError } from "@/components/forms/use-restore-on-error";
import { useRef } from "react";

interface HiveOption {
  id: string;
  positionLabel: string;
  standLabel?: string;
}

interface BulkFeedingFormProps {
  hives: HiveOption[];
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

export function BulkFeedingForm({ hives }: BulkFeedingFormProps) {
  const [selectedHiveIds, setSelectedHiveIds] = useState<string[]>([]);
  const [state, formAction, isPending] = useActionState(bulkCreateFeedings, null);
  const formRef = useRef<HTMLFormElement>(null);
  useRestoreOnError(
    formRef,
    (state as { values?: Record<string, string> } | null)?.values
  );

  const errorMessage =
    state && typeof state === "object" && "error" in state
      ? (state as { error: string }).error
      : null;

  const successCount =
    state && typeof state === "object" && "success" in state && "count" in state
      ? (state as { success: boolean; count: number }).count
      : null;

  const dateValue = new Date().toISOString().split("T")[0];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bulk Feeding</CardTitle>
      </CardHeader>
      <CardContent>
        {errorMessage && (
          <p className="text-destructive text-sm mb-4">{errorMessage}</p>
        )}
        {successCount && (
          <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm mb-4 p-3 bg-green-50 dark:bg-green-950 rounded-lg">
            <CheckCircle className="h-4 w-4" />
            <span>Successfully created {successCount} feeding(s)</span>
          </div>
        )}
        <form ref={formRef} action={formAction} className="space-y-6">
          <input type="hidden" name="hiveIds" value={JSON.stringify(selectedHiveIds)} />

          <HiveMultiSelector
            hives={hives}
            value={selectedHiveIds}
            onChange={setSelectedHiveIds}
          />

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

          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              name="notes"
              rows={3}
              placeholder="Notes for all feedings..."
            />
          </div>

          <Button
            type="submit"
            disabled={isPending || selectedHiveIds.length === 0}
            className="w-full"
          >
            {isPending ? "Creating..." : `Create ${selectedHiveIds.length} Feeding(s)`}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
