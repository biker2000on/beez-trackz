"use client";

/**
 * Reusable per-jar-size line editor shared by the jarring, sale, give-away,
 * and adjust dialogs: one row per active size with a quantity input and
 * optional price / on-hand / new-total columns.
 */

import Link from "next/link";

import { Input } from "@/components/ui/input";
import { BottlingRunPicker } from "@/features/commerce/bottling-run-picker";
import { cn } from "@/lib/utils";

import { parseNum } from "./format";
import type { HoneyInventoryRow } from "./types";

export interface JarLineValue {
  jarSizeId: string;
  quantity: string;
  unitPrice?: string;
  bottlingRunId?: string;
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
  /**
   * On-hand counts that override each row's own (e.g. the jars standing at
   * the shelf a sale comes off). A size missing from the map counts as zero.
   */
  onHandBySize?: Map<string, number>;
  /** Where the on-hand count is measured, e.g. "at Corner market". */
  onHandWhere?: string;
  /**
   * Leave out sizes with nothing on hand. A row the operator has already
   * typed a quantity into stays, so a shelf that empties mid-entry never
   * swallows the line.
   */
  hideEmpty?: boolean;
  /** Flag a quantity above on hand in amber; never blocks the submit. */
  warnOverdraw?: boolean;
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
  onHandBySize,
  onHandWhere,
  hideEmpty = false,
  warnOverdraw = false,
  disabled = false,
}: JarLinesEditorProps) {
  const bySize = new Map(rows.map((row) => [row.jarSizeId, row]));
  const onHandOf = (row: HoneyInventoryRow) =>
    onHandBySize ? (onHandBySize.get(row.jarSizeId) ?? 0) : row.onHand;

  function update(index: number, patch: Partial<JarLineValue>) {
    onChange(
      value.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No jar sizes configured.{" "}
        <Link
          href="/admin/setup#jar-sizes"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Add sizes in Operation setup
        </Link>{" "}
        first.
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

  const visible = value.filter((line) => {
    const row = bySize.get(line.jarSizeId);
    if (!row) return false;
    if (!hideEmpty) return true;
    return onHandOf(row) > 0 || (parseNum(line.quantity) ?? 0) !== 0;
  });

  if (visible.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No jars on hand{onHandWhere ? ` ${onHandWhere}` : ""}.
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      <div className={cn(gridClass, "text-xs font-medium text-muted-foreground")}>
        <span>Size</span>
        <span>{allowNegative ? "± Qty" : "Qty"}</span>
        {showPrice && <span>Unit price</span>}
        {showNewTotal && <span className="text-right">New</span>}
      </div>
      {visible.map((line) => {
        const index = value.indexOf(line);
        const row = bySize.get(line.jarSizeId);
        if (!row) return null;
        const delta = parseNum(line.quantity) ?? 0;
        const onHand = onHandOf(row);
        const over = warnOverdraw && delta > onHand;
        return (
          <div key={line.jarSizeId} className={gridClass}>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {row.label}
                {row.honeyOz ? (
                  <span className="font-normal text-muted-foreground"> · {row.honeyOz} oz</span>
                ) : null}
              </p>
              {showOnHand && (
                <p
                  className={cn(
                    "text-xs",
                    over
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-muted-foreground",
                  )}
                >
                  {onHand} on hand{onHandWhere ? ` ${onHandWhere}` : ""}
                  {over ? ` · ${delta - onHand} more than that` : ""}
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
            {showPrice && (
              <div className="col-span-full">
                <BottlingRunPicker
                  jarSizeId={line.jarSizeId}
                  value={line.bottlingRunId}
                  onChange={(bottlingRunId) =>
                    update(index, { bottlingRunId })
                  }
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
                {onHand + delta}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
