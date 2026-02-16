"use client";

import { useActionState, useState, useEffect } from "react";
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
import { generatePositionLabel } from "@/lib/hive-location";

interface HiveFormProps {
  action: (prevState: unknown, formData: FormData) => Promise<unknown>;
  defaultValues?: {
    positionLabel?: string | null;
    standId?: string | null;
    slotRow?: number | null;
    slotCol?: number | null;
    placement?: string | null;
    status?: string | null;
    installedDate?: Date | null;
    notes?: string | null;
    apiaryId?: string | null;
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

  // State for structured location fields
  const [standId, setStandId] = useState(defaultValues?.standId ?? "");
  const [slotRow, setSlotRow] = useState(defaultValues?.slotRow?.toString() ?? "");
  const [slotCol, setSlotCol] = useState(defaultValues?.slotCol?.toString() ?? "");
  const [placement, setPlacement] = useState(defaultValues?.placement ?? "full");
  const [positionLabel, setPositionLabel] = useState(defaultValues?.positionLabel ?? "");

  // Auto-generate position label when location fields change
  useEffect(() => {
    if (standId || slotRow || slotCol) {
      const generated = generatePositionLabel(
        standId,
        slotRow ? parseInt(slotRow) : null,
        slotCol ? parseInt(slotCol) : null,
        placement
      );
      setPositionLabel(generated);
    }
  }, [standId, slotRow, slotCol, placement]);

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

          {/* Structured Location Fields */}
          <div className="space-y-2">
            <Label>Location</Label>
            <div className="flex gap-2">
              <div className="flex-1">
                <Input
                  id="standId"
                  name="standId"
                  placeholder="Stand (e.g. A, B, North)"
                  value={standId}
                  onChange={(e) => setStandId(e.target.value)}
                />
              </div>
              <div className="w-24">
                <Input
                  id="slotRow"
                  name="slotRow"
                  type="number"
                  placeholder="Row"
                  value={slotRow}
                  onChange={(e) => setSlotRow(e.target.value)}
                />
              </div>
              <div className="w-24">
                <Input
                  id="slotCol"
                  name="slotCol"
                  type="number"
                  placeholder="Col"
                  value={slotCol}
                  onChange={(e) => setSlotCol(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="placement">Placement</Label>
            <Select
              name="placement"
              value={placement}
              onValueChange={setPlacement}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select placement" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full">Full</SelectItem>
                <SelectItem value="top">Top</SelectItem>
                <SelectItem value="bottom">Bottom</SelectItem>
                <SelectItem value="left">Left</SelectItem>
                <SelectItem value="right">Right</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="positionLabel">Position Label</Label>
            <Input
              id="positionLabel"
              name="positionLabel"
              placeholder="Auto-generated from location or enter manually"
              value={positionLabel}
              onChange={(e) => setPositionLabel(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Auto-generated from location or enter manually
            </p>
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
