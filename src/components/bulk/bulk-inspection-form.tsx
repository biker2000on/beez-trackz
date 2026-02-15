"use client";

import { useState, useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HiveMultiSelector } from "@/components/bulk/hive-multi-selector";
import { CheckCircle } from "lucide-react";
import { bulkCreateInspections } from "@/actions/bulk";

interface HiveOption {
  id: string;
  positionLabel: string;
  standLabel?: string;
}

interface BulkInspectionFormProps {
  hives: HiveOption[];
}

export function BulkInspectionForm({ hives }: BulkInspectionFormProps) {
  const [selectedHiveIds, setSelectedHiveIds] = useState<string[]>([]);
  const [state, formAction, isPending] = useActionState(bulkCreateInspections, null);

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
        <CardTitle>Bulk Inspection</CardTitle>
      </CardHeader>
      <CardContent>
        {errorMessage && (
          <p className="text-destructive text-sm mb-4">{errorMessage}</p>
        )}
        {successCount && (
          <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm mb-4 p-3 bg-green-50 dark:bg-green-950 rounded-lg">
            <CheckCircle className="h-4 w-4" />
            <span>Successfully created {successCount} inspection(s)</span>
          </div>
        )}
        <form action={formAction} className="space-y-6">
          <input type="hidden" name="hiveIds" value={JSON.stringify(selectedHiveIds)} />

          <HiveMultiSelector
            hives={hives}
            value={selectedHiveIds}
            onChange={setSelectedHiveIds}
          />

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

          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              name="notes"
              rows={3}
              placeholder="Notes for all selected hive inspections..."
            />
          </div>

          <Button
            type="submit"
            disabled={isPending || selectedHiveIds.length === 0}
            className="w-full"
          >
            {isPending ? "Creating..." : `Create ${selectedHiveIds.length} Inspection(s)`}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
