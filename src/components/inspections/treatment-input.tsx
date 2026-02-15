"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, X } from "lucide-react";

interface TreatmentRow {
  product: string;
  method: string;
  dateApplied: string;
  dateToRemove: string;
}

interface TreatmentInputProps {
  defaultValue?: TreatmentRow[];
}

export function TreatmentInput({ defaultValue = [] }: TreatmentInputProps) {
  const [rows, setRows] = useState<TreatmentRow[]>(
    defaultValue.length > 0 ? defaultValue : []
  );

  function addRow() {
    setRows((prev) => [
      ...prev,
      { product: "", method: "", dateApplied: "", dateToRemove: "" },
    ]);
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function updateField(
    index: number,
    field: keyof TreatmentRow,
    value: string
  ) {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row))
    );
  }

  return (
    <div className="space-y-3">
      <input type="hidden" name="treatments" value={JSON.stringify(rows)} />

      {rows.map((row, index) => (
        <div key={index} className="rounded-lg border p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">
              Treatment {index + 1}
            </span>
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

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Product</Label>
              <Input
                value={row.product}
                onChange={(e) => updateField(index, "product", e.target.value)}
                placeholder="e.g. ApiVar"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Method</Label>
              <Input
                value={row.method}
                onChange={(e) => updateField(index, "method", e.target.value)}
                placeholder="e.g. strip"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Date Applied</Label>
              <Input
                type="date"
                value={row.dateApplied}
                onChange={(e) =>
                  updateField(index, "dateApplied", e.target.value)
                }
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Date to Remove</Label>
              <Input
                type="date"
                value={row.dateToRemove}
                onChange={(e) =>
                  updateField(index, "dateToRemove", e.target.value)
                }
              />
            </div>
          </div>
        </div>
      ))}

      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        <Plus className="h-4 w-4 mr-2" />
        Add Treatment
      </Button>
    </div>
  );
}
