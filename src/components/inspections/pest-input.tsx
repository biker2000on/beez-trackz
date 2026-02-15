"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, X } from "lucide-react";

const PEST_TYPES = [
  { value: "small_hive_beetle", label: "Small Hive Beetle" },
  { value: "varroa", label: "Varroa Mite" },
  { value: "wax_moth", label: "Wax Moth" },
  { value: "ant", label: "Ants" },
  { value: "other", label: "Other" },
];

interface PestRow {
  type: string;
  count: number;
}

interface PestInputProps {
  defaultValue?: PestRow[];
}

export function PestInput({ defaultValue = [] }: PestInputProps) {
  const [rows, setRows] = useState<PestRow[]>(
    defaultValue.length > 0 ? defaultValue : []
  );

  function addRow() {
    setRows((prev) => [...prev, { type: "varroa", count: 0 }]);
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function updateType(index: number, type: string) {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, type } : row))
    );
  }

  function updateCount(index: number, count: number) {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, count } : row))
    );
  }

  return (
    <div className="space-y-2">
      <input type="hidden" name="pests" value={JSON.stringify(rows)} />

      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <Select
            value={row.type}
            onValueChange={(value) => updateType(index, value)}
          >
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Pest type" />
            </SelectTrigger>
            <SelectContent>
              {PEST_TYPES.map((pest) => (
                <SelectItem key={pest.value} value={pest.value}>
                  {pest.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input
            type="number"
            min={0}
            value={row.count}
            onChange={(e) => updateCount(index, parseInt(e.target.value) || 0)}
            className="w-20"
            placeholder="Count"
          />

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => removeRow(index)}
            className="px-2"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}

      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        <Plus className="h-4 w-4 mr-2" />
        Add Pest
      </Button>
    </div>
  );
}
