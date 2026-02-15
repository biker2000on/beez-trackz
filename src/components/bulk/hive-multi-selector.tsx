"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

interface HiveOption {
  id: string;
  positionLabel: string;
  standLabel?: string;
}

interface HiveMultiSelectorProps {
  hives: HiveOption[];
  value: string[];
  onChange: (ids: string[]) => void;
}

export function HiveMultiSelector({ hives, value, onChange }: HiveMultiSelectorProps) {
  const [rangeText, setRangeText] = useState("");

  // Group hives by stand
  const grouped = hives.reduce<Record<string, HiveOption[]>>((acc, h) => {
    const stand = h.standLabel || "Unassigned";
    if (!acc[stand]) acc[stand] = [];
    acc[stand].push(h);
    return acc;
  }, {});

  const toggleHive = (id: string) => {
    onChange(
      value.includes(id) ? value.filter((v) => v !== id) : [...value, id]
    );
  };

  const selectAll = () => onChange(hives.map((h) => h.id));
  const selectNone = () => onChange([]);

  const selectStand = (standHives: HiveOption[]) => {
    const standIds = standHives.map((h) => h.id);
    const allSelected = standIds.every((id) => value.includes(id));
    if (allSelected) {
      onChange(value.filter((v) => !standIds.includes(v)));
    } else {
      const newValue = new Set([...value, ...standIds]);
      onChange(Array.from(newValue));
    }
  };

  const applyRange = () => {
    const parts = rangeText.split(",").map((s) => s.trim()).filter(Boolean);
    const ids = new Set<string>();

    for (const part of parts) {
      const rangeParts = part.split("-").map((s) => s.trim());
      if (rangeParts.length === 2) {
        const start = rangeParts[0];
        const end = rangeParts[1];
        let inRange = false;
        for (const h of hives) {
          if (h.positionLabel.toLowerCase() === start.toLowerCase()) inRange = true;
          if (inRange) ids.add(h.id);
          if (h.positionLabel.toLowerCase() === end.toLowerCase()) break;
        }
      } else {
        const match = hives.find(
          (h) => h.positionLabel.toLowerCase() === part.toLowerCase()
        );
        if (match) ids.add(match.id);
      }
    }

    onChange(Array.from(ids));
  };

  return (
    <div className="border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <Label className="text-sm font-semibold">
          Select Hives ({value.length} of {hives.length} selected)
        </Label>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={selectAll}>
            All
          </Button>
          <Button variant="ghost" size="sm" onClick={selectNone}>
            None
          </Button>
        </div>
      </div>
      <Tabs defaultValue="list">
        <TabsList className="mb-2">
          <TabsTrigger value="list">Checkbox List</TabsTrigger>
          <TabsTrigger value="range">Range Picker</TabsTrigger>
        </TabsList>
        <TabsContent value="list">
          <div className="max-h-48 overflow-y-auto space-y-3">
            {Object.entries(grouped).map(([stand, standHives]) => (
              <div key={stand}>
                <button
                  type="button"
                  className="text-xs font-semibold text-muted-foreground uppercase mb-1 hover:text-foreground cursor-pointer"
                  onClick={() => selectStand(standHives)}
                >
                  Stand {stand} ({standHives.filter((h) => value.includes(h.id)).length}/{standHives.length})
                </button>
                <div className="grid grid-cols-4 gap-1">
                  {standHives.map((h) => (
                    <label
                      key={h.id}
                      className="flex items-center gap-1.5 text-sm cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-input"
                        checked={value.includes(h.id)}
                        onChange={() => toggleHive(h.id)}
                      />
                      {h.positionLabel}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="range">
          <div className="flex gap-2">
            <Input
              value={rangeText}
              onChange={(e) => setRangeText(e.target.value)}
              placeholder="e.g. A1-C4 or A1, B2, C1-C3"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyRange();
                }
              }}
            />
            <Button onClick={applyRange} size="sm">
              Apply
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Use commas to separate ranges. Press Enter or click Apply.
          </p>
        </TabsContent>
      </Tabs>
    </div>
  );
}
