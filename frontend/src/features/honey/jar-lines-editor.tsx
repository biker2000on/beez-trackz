"use client";

/**
 * Reusable per-jar-size line editor shared by the jarring, sale, give-away,
 * and adjust dialogs: one row per active size with a quantity input and
 * optional price / on-hand / new-total columns.
 */

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { parseNum } from "./format";
import type { HoneyInventoryRow } from "./types";

export interface JarLineValue {
  jarSizeId: string;
  quantity: string;
  unitPrice?: string;
}

/** Build the initial (empty) lines for a set of inventory rows. */
export function makeJarLines(
  rows: HoneyInventoryRow[],
  options: { withPrice?: boolean } = {},
): JarLineValue[] {
  return rows.map((row) => ({
    jarSizeId: row.jarSizeId,
    quantity: "",
    ...(options.withPrice
      ? { unitPrice: row.defaultPrice != null ? String(row.defaultPrice) : "" }
      : {}),
  }));
}

interface JarLinesEditorProps {
  rows: HoneyInventoryRow[];
  value: JarLineValue[];
  onChange: (value: JarLineValue[]) => void;
  /** Show a unit-price input per line (sales). */
  showPrice?: boolean;
  /** Show the current on-hand count under each label. */
  showOnHand?: boolean;
  /** Allow negative quantities (jar adjustments). */
  allowNegative?: boolean;
  /** Show the resulting on-hand total per line (jar adjustments). */
  showNewTotal?: boolean;
  disabled?: boolean;
}

export function JarLinesEditor({
  rows,
  value,
  onChange,
  showPrice = false,
  showOnHand = false,
  allowNegative = false,
  showNewTotal = false,
  disabled = false,
}: JarLinesEditorProps) {
  const bySize = new Map(rows.map((row) => [row.jarSizeId, row]));

  function update(index: number, patch: Partial<JarLineValue>) {
    onChange(
      value.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No jar sizes configured. Add sizes in Settings first.
      </p>
    );
  }

  const gridClass = cn(
    "grid items-center gap-2",
    showPrice
      ? "grid-cols-[1fr_5rem_6.5rem]"
      : showNewTotal
        ? "grid-cols-[1fr_5.5rem_4.5rem]"
        : "grid-cols-[1fr_5.5rem]",
  );

  return (
    <div className="grid gap-2">
      <div className={cn(gridClass, "text-xs font-medium text-muted-foreground")}>
        <span>Size</span>
        <span>{allowNegative ? "± Qty" : "Qty"}</span>
        {showPrice && <span>Unit price</span>}
        {showNewTotal && <span className="text-right">New</span>}
      </div>
      {value.map((line, index) => {
        const row = bySize.get(line.jarSizeId);
        if (!row) return null;
        const delta = parseNum(line.quantity) ?? 0;
        return (
          <div key={line.jarSizeId} className={gridClass}>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{row.label}</p>
              {showOnHand && (
                <p className="text-xs text-muted-foreground">
                  {row.onHand} on hand
                </p>
              )}
            </div>
            <Input
              type="number"
              inputMode="numeric"
              step={1}
              min={allowNegative ? undefined : 0}
              placeholder="0"
              aria-label={`${row.label} quantity`}
              value={line.quantity}
              onChange={(e) => update(index, { quantity: e.target.value })}
              disabled={disabled}
            />
            {showPrice && (
              <div className="relative">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  className="pl-6"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={0}
                  placeholder="0.00"
                  aria-label={`${row.label} unit price`}
                  value={line.unitPrice ?? ""}
                  onChange={(e) => update(index, { unitPrice: e.target.value })}
                  disabled={disabled}
                />
              </div>
            )}
            {showNewTotal && (
              <p
                className={cn(
                  "text-right text-sm tabular-nums",
                  delta !== 0
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {row.onHand + delta}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
