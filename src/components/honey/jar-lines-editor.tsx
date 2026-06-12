"use client";

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

export interface JarSizeOption {
  id: string;
  label: string;
  honeyOz: number | null;
  defaultPrice: number | null;
  onHand?: number;
}

export interface EditorLine {
  jarSizeId: string;
  quantity: string;
  unitPrice?: string;
}

/**
 * Multi-line jar entry shared by jarring, sales, give-away, and adjustment
 * dialogs. Mobile-first: each line is a single row with large touch targets.
 */
export function JarLinesEditor({
  sizes,
  lines,
  onChange,
  withPrice = false,
  showOnHand = false,
  quantityLabel = "Qty",
}: {
  sizes: JarSizeOption[];
  lines: EditorLine[];
  onChange: (lines: EditorLine[]) => void;
  withPrice?: boolean;
  showOnHand?: boolean;
  quantityLabel?: string;
}) {
  const update = (index: number, patch: Partial<EditorLine>) => {
    onChange(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

  const addLine = () => {
    const used = new Set(lines.map((l) => l.jarSizeId));
    const next = sizes.find((s) => !used.has(s.id)) ?? sizes[0];
    onChange([
      ...lines,
      {
        jarSizeId: next?.id ?? "",
        quantity: "",
        ...(withPrice
          ? { unitPrice: next?.defaultPrice != null ? String(next.defaultPrice) : "" }
          : {}),
      },
    ]);
  };

  return (
    <div className="space-y-2">
      {lines.map((line, index) => {
        const size = sizes.find((s) => s.id === line.jarSizeId);
        return (
          <div key={index} className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <Select
                value={line.jarSizeId}
                onValueChange={(v) => {
                  const newSize = sizes.find((s) => s.id === v);
                  update(index, {
                    jarSizeId: v,
                    ...(withPrice && newSize?.defaultPrice != null && !line.unitPrice
                      ? { unitPrice: String(newSize.defaultPrice) }
                      : {}),
                  });
                }}
              >
                <SelectTrigger className="h-10">
                  <SelectValue placeholder="Jar size" />
                </SelectTrigger>
                <SelectContent>
                  {sizes.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                      {showOnHand && s.onHand != null ? ` — ${s.onHand} on hand` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              placeholder={quantityLabel}
              className="w-20 h-10 text-right tabular-nums"
              value={line.quantity}
              onChange={(e) => update(index, { quantity: e.target.value })}
            />
            {withPrice && (
              <div className="relative w-24">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  placeholder="0.00"
                  className="h-10 pl-6 text-right tabular-nums"
                  value={line.unitPrice ?? ""}
                  onChange={(e) => update(index, { unitPrice: e.target.value })}
                />
              </div>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-10 w-10 shrink-0 text-muted-foreground"
              onClick={() => onChange(lines.filter((_, i) => i !== index))}
              aria-label="Remove line"
            >
              <X className="h-4 w-4" />
            </Button>
            {showOnHand && size?.onHand != null && (
              <span className="sr-only">{size.onHand} on hand</span>
            )}
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" onClick={addLine} className="gap-1.5">
        <Plus className="h-3.5 w-3.5" />
        Add line
      </Button>
    </div>
  );
}

export function parseLines(lines: EditorLine[]) {
  return lines
    .map((l) => ({
      jarSizeId: l.jarSizeId,
      quantity: parseInt(l.quantity) || 0,
      unitPrice: l.unitPrice != null ? parseFloat(l.unitPrice) || 0 : undefined,
    }))
    .filter((l) => l.jarSizeId && l.quantity > 0);
}
