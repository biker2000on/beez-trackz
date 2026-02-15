"use client";

import { useState } from "react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const EQUIPMENT_TYPES = [
  { value: "deep", label: "Deep Body" },
  { value: "medium", label: "Medium Super" },
  { value: "shallow", label: "Shallow Super" },
  { value: "queen_excluder", label: "Queen Excluder" },
  { value: "double_screen", label: "Double Screen" },
  { value: "inner_cover", label: "Inner Cover" },
  { value: "outer_cover", label: "Outer Cover" },
  { value: "bottom_board", label: "Bottom Board" },
  { value: "entrance_reducer", label: "Entrance Reducer" },
  { value: "feeder", label: "Feeder" },
  { value: "other", label: "Other" },
] as const;

const FRAME_TYPES = [
  { value: "wax_foundation", label: "Wax Foundation" },
  { value: "plastic", label: "Plastic" },
  { value: "foundationless", label: "Foundationless" },
  { value: "drawn_comb", label: "Drawn Comb" },
] as const;

const BOX_TYPES = new Set(["deep", "medium", "shallow"]);

interface EquipmentFormProps {
  action: (prevState: unknown, formData: FormData) => Promise<unknown>;
  hives?: { id: string; label: string }[];
  defaultHiveId?: string;
  title: string;
  submitLabel: string;
}

export function EquipmentForm({
  action,
  hives,
  defaultHiveId,
  title,
  submitLabel,
}: EquipmentFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const [selectedType, setSelectedType] = useState("");
  const [selectedHive, setSelectedHive] = useState(defaultHiveId || "");

  const errorMessage =
    state && typeof state === "object" && "error" in state
      ? (state as { error: string }).error
      : null;

  const isBox = BOX_TYPES.has(selectedType);
  const showStorage = !selectedHive;

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
          {/* Equipment type */}
          <div className="space-y-2">
            <Label htmlFor="type">Equipment Type *</Label>
            <Select
              name="type"
              required
              value={selectedType}
              onValueChange={setSelectedType}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                {EQUIPMENT_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Frame fields -- only for box types */}
          {isBox && (
            <>
              <div className="space-y-2">
                <Label htmlFor="frameCapacity">Frame Capacity</Label>
                <Input
                  id="frameCapacity"
                  name="frameCapacity"
                  type="number"
                  min={0}
                  max={30}
                  placeholder="e.g. 10"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="framesInstalled">Frames Installed</Label>
                <Input
                  id="framesInstalled"
                  name="framesInstalled"
                  type="number"
                  min={0}
                  max={30}
                  placeholder="e.g. 8"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="frameType">Frame Type</Label>
                <Select name="frameType">
                  <SelectTrigger>
                    <SelectValue placeholder="Select frame type" />
                  </SelectTrigger>
                  <SelectContent>
                    {FRAME_TYPES.map((ft) => (
                      <SelectItem key={ft.value} value={ft.value}>
                        {ft.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {/* Quantity */}
          <div className="space-y-2">
            <Label htmlFor="quantity">Quantity</Label>
            <Input
              id="quantity"
              name="quantity"
              type="number"
              min={1}
              defaultValue={1}
              placeholder="1"
            />
          </div>

          {/* Hive assignment */}
          {hives && hives.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="hiveId">Assign to Hive</Label>
              <Select
                value={selectedHive || "__none__"}
                onValueChange={(v) => setSelectedHive(v === "__none__" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="None (store in storage)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None (storage)</SelectItem>
                  {hives.map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input type="hidden" name="hiveId" value={selectedHive} />
            </div>
          )}

          {/* Storage location -- only when no hive */}
          {showStorage && (
            <div className="space-y-2">
              <Label htmlFor="storageLocation">Storage Location</Label>
              <Input
                id="storageLocation"
                name="storageLocation"
                placeholder="e.g. Shed, Garage shelf 3"
              />
            </div>
          )}

          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving..." : submitLabel}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
