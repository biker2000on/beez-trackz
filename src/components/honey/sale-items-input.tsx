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

const JAR_SIZES = [
  { value: "8oz", label: "8 oz" },
  { value: "1lb", label: "1 lb" },
  { value: "2lb", label: "2 lb" },
  { value: "quart", label: "Quart" },
];

interface SaleItem {
  jarSize: string;
  quantity: number;
  pricePerUnit: number;
}

export function SaleItemsInput() {
  const [rows, setRows] = useState<SaleItem[]>([
    { jarSize: "", quantity: 1, pricePerUnit: 0 },
  ]);

  function addRow() {
    setRows((prev) => [...prev, { jarSize: "", quantity: 1, pricePerUnit: 0 }]);
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function updateField(index: number, field: keyof SaleItem, value: string | number) {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row))
    );
  }

  const total = rows.reduce(
    (sum, row) => sum + row.quantity * row.pricePerUnit,
    0
  );

  // Serialize valid rows (those with a jar size) to JSON
  const validRows = rows.filter((r) => r.jarSize);

  return (
    <div className="space-y-3">
      <input
        type="hidden"
        name="items"
        value={JSON.stringify(validRows)}
      />

      {/* Header */}
      <div className="grid grid-cols-[1fr_80px_100px_32px] gap-2 text-xs font-medium text-muted-foreground">
        <span>Jar Size</span>
        <span>Qty</span>
        <span>Price/Unit</span>
        <span />
      </div>

      {rows.map((row, index) => (
        <div
          key={index}
          className="grid grid-cols-[1fr_80px_100px_32px] gap-2 items-center"
        >
          <Select
            value={row.jarSize}
            onValueChange={(value) => updateField(index, "jarSize", value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Size" />
            </SelectTrigger>
            <SelectContent>
              {JAR_SIZES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input
            type="number"
            min={1}
            value={row.quantity}
            onChange={(e) =>
              updateField(index, "quantity", parseInt(e.target.value) || 0)
            }
          />

          <Input
            type="number"
            step="0.01"
            min={0}
            value={row.pricePerUnit || ""}
            onChange={(e) =>
              updateField(
                index,
                "pricePerUnit",
                parseFloat(e.target.value) || 0
              )
            }
            placeholder="$0.00"
          />

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => removeRow(index)}
            disabled={rows.length === 1}
            className="px-2"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}

      <div className="flex items-center justify-between">
        <Button type="button" variant="outline" size="sm" onClick={addRow}>
          <Plus className="h-4 w-4 mr-2" />
          Add Item
        </Button>

        <div className="text-sm font-medium">
          Total: <span className="text-base">${total.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}
