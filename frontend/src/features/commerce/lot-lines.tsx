"use client";

/**
 * Line-based jar picker shared by every form that takes jars off a shelf:
 * consignment transfers, sales, give-aways.
 *
 * Each line is [Size] [Varietal / lot · N left] [Units] (and, for a sale,
 * [Unit price] [line total]). Honey is sold by varietal, so the lot is part of
 * the line, not a sale-wide afterthought: a size with exactly one lot holding
 * stock preselects it, sizes and lots with nothing left are never offered,
 * and every count is "what is left after the OTHER lines", so two lines of
 * Sourwood quarts cannot both claim the same twelve jars.
 *
 * Only consignment transfers pass `allowAnyLot` (the "Any lot (oldest first)"
 * escape hatch, where the server picks). Everywhere else a jar line without a
 * lot is an error the operator sees before the server refuses it.
 */

import * as React from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatMoney } from "@/features/honey/format";
import { cn } from "@/lib/utils";

import type { StockInventoryRow, StockLotRef } from "./stock-locations-api";

/** "Any lot" is the empty string: the line submits no `harvestLotId`. */
export const ANY_LOT = "";

/** SKU identity that works for both jar sizes and catalog products. */
export function skuKey(row: { jarSizeId: string | null; productId: string | null }) {
  return row.jarSizeId ? `jar:${row.jarSizeId}` : `product:${row.productId}`;
}

/** "Sourwood · 2025-SW", or whichever half is known. */
export function lotLabel(row: StockLotRef): string {
  if (row.varietalName && row.lotCode) return `${row.varietalName} · ${row.lotCode}`;
  return row.varietalName ?? row.lotCode ?? "No lot";
}

export function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a.localeCompare(b);
}

/** One lot of a SKU and how many of its units stand at the chosen shelf. */
export interface ShelfLot {
  harvestLotId: string;
  lotCode: string | null;
  varietalName: string | null;
  at: number;
}

/** One SKU standing at the chosen shelf, split by lot. */
export interface ShelfSku {
  key: string;
  jarSizeId: string | null;
  productId: string | null;
  label: string;
  kind: string;
  unitPrice: number | null;
  /** Every unit of this SKU at the shelf, attributed to a lot or not. */
  at: number;
  /** Lots of this SKU with something at the shelf, varietal then code. */
  lots: ShelfLot[];
  /** Units at the shelf no harvest lot claims (old counts, recounts). */
  unattributed: number;
  /** Whether a line of this SKU must name a lot (every jar size). */
  lotTracked: boolean;
}

/**
 * The stock matrix narrowed to one shelf: SKUs with something there, each
 * with its lots that have something there. Lots and SKUs at zero are dropped.
 */
export function shelfSkus(
  items: StockInventoryRow[] | undefined,
  locationId: string | undefined,
  options: { jarsOnly?: boolean } = {},
): ShelfSku[] {
  if (!items || !locationId) return [];
  return items
    .filter((row) => !options.jarsOnly || row.jarSizeId != null)
    .map((row) => {
      const at = row.byLocation[locationId] ?? 0;
      const lots = (row.lots ?? [])
        .map((lot) => ({
          harvestLotId: lot.harvestLotId ?? "",
          lotCode: lot.lotCode,
          varietalName: lot.varietalName,
          at: lot.byLocation[locationId] ?? 0,
        }))
        .filter((lot) => lot.harvestLotId !== "" && lot.at > 0)
        .sort(
          (a, b) =>
            compareNullable(a.varietalName, b.varietalName) ||
            compareNullable(a.lotCode, b.lotCode),
        );
      const inLots = lots.reduce((sum, lot) => sum + lot.at, 0);
      return {
        key: skuKey(row),
        jarSizeId: row.jarSizeId,
        productId: row.productId,
        label: row.label,
        kind: row.kind,
        unitPrice: row.unitPrice,
        at,
        lots,
        unattributed: Math.max(0, at - inLots),
        lotTracked: row.jarSizeId != null,
      };
    })
    .filter((row) => row.at > 0);
}

export interface LotLine {
  id: number;
  sku: string;
  lot: string;
  qty: string;
  /** Unit price text; only forms that sell use it. */
  price: string;
}

/** A line's whole-unit count; blank or unevaluated text counts as 0. */
export function qtyOf(line: { qty: string }): number {
  return Math.max(0, Math.trunc(Number(line.qty) || 0));
}

/** A line's unit price, or null when blank or not a number. */
export function priceOf(line: { price: string }): number | null {
  if (line.price.trim() === "") return null;
  const value = Number(line.price);
  return Number.isFinite(value) ? value : null;
}

export interface LotLinesOptions {
  /** Offer "Any lot (oldest first)" on jar lines instead of requiring one. */
  allowAnyLot?: boolean;
  /** The price a line starts at when its size is chosen (sales). */
  defaultPrice?: (sku: ShelfSku) => string;
  /** Where counts are measured, for messages: "at home". */
  where?: string;
}

/**
 * Lines plus the availability math. Every number is per lot and net of the
 * other lines; `errors` holds what would make the server refuse.
 */
export function useLotLines(skus: ShelfSku[], options: LotLinesOptions = {}) {
  const { allowAnyLot = false, defaultPrice, where = "here" } = options;
  const nextId = React.useRef(1);
  const blankLine = React.useCallback(
    (): LotLine => ({ id: nextId.current++, sku: "", lot: ANY_LOT, qty: "", price: "" }),
    [],
  );
  const [lines, setLines] = React.useState<LotLine[]>([
    { id: 0, sku: "", lot: ANY_LOT, qty: "", price: "" },
  ]);
  const skuByKey = new Map(skus.map((row) => [row.key, row]));

  /** Units a SKU line can draw from: lots only, unless "any lot" is allowed. */
  function sellable(sku: ShelfSku): number {
    if (!sku.lotTracked || allowAnyLot) return sku.at;
    return sku.at - sku.unattributed;
  }

  function skuTakenByOthers(line: LotLine, key: string): number {
    return lines.reduce(
      (sum, other) => (other.id !== line.id && other.sku === key ? sum + qtyOf(other) : sum),
      0,
    );
  }

  function lotTakenByOthers(line: LotLine, key: string, lotId: string): number {
    return lines.reduce(
      (sum, other) =>
        other.id !== line.id && other.sku === key && other.lot === lotId
          ? sum + qtyOf(other)
          : sum,
      0,
    );
  }

  /** What is left of a SKU for this line. */
  function skuLeftFor(line: LotLine, sku: ShelfSku): number {
    return Math.max(0, sellable(sku) - skuTakenByOthers(line, sku.key));
  }

  /** What is left of one lot for this line, bounded by the SKU. */
  function lotLeftFor(line: LotLine, sku: ShelfSku, lot: ShelfLot): number {
    const left = lot.at - lotTakenByOthers(line, sku.key, lot.harvestLotId);
    return Math.max(0, Math.min(left, skuLeftFor(line, sku)));
  }

  /** The quantity cap for a line: its (SKU, lot) after every other line. */
  function capOf(line: LotLine): number {
    const sku = skuByKey.get(line.sku);
    if (!sku) return 0;
    if (!sku.lotTracked || line.lot === ANY_LOT) {
      return sku.lotTracked && !allowAnyLot ? 0 : skuLeftFor(line, sku);
    }
    const lot = sku.lots.find((row) => row.harvestLotId === line.lot);
    return lot ? lotLeftFor(line, sku, lot) : 0;
  }

  /** Lots this line may pick: something left, and not pinned by another line. */
  function lotOptions(line: LotLine): { lot: ShelfLot; left: number }[] {
    const sku = skuByKey.get(line.sku);
    if (!sku) return [];
    return sku.lots
      .map((lot) => ({ lot, left: lotLeftFor(line, sku, lot) }))
      .filter(
        ({ lot, left }) =>
          lot.harvestLotId === line.lot ||
          (left > 0 &&
            !lines.some(
              (other) =>
                other.id !== line.id && other.sku === line.sku && other.lot === lot.harvestLotId,
            )),
      );
  }

  /** Sizes this line may pick: something left after the other lines. */
  function skuOptions(line: LotLine): { sku: ShelfSku; left: number }[] {
    return skus
      .map((sku) => ({ sku, left: skuLeftFor(line, sku) }))
      .filter(({ sku, left }) => left > 0 || sku.key === line.sku);
  }

  const errors = new Map<number, string>();
  lines.forEach((line, index) => {
    const sku = skuByKey.get(line.sku);
    if (!sku) return;
    const first = lines.findIndex((other) => other.sku === line.sku && other.lot === line.lot);
    if (first >= 0 && first < index && (line.lot !== ANY_LOT || !sku.lotTracked || allowAnyLot)) {
      errors.set(line.id, `Same size and lot as line ${first + 1}. Add the units to that line instead.`);
      return;
    }
    const qty = qtyOf(line);
    if (sku.lotTracked && !allowAnyLot && line.lot === ANY_LOT) {
      if (qty > 0) errors.set(line.id, "Choose the varietal / lot these jars come off.");
      return;
    }
    const cap = capOf(line);
    if (qty > cap) {
      errors.set(
        line.id,
        cap === 0
          ? `None left ${where} after the other lines.`
          : `Only ${cap} left ${where} after the other lines.`,
      );
      return;
    }
    if (defaultPrice && qty > 0) {
      const price = priceOf(line);
      if (price == null || price < 0) errors.set(line.id, "Enter a unit price (0 for a gift).");
    }
  });

  /** Lines with a SKU and a quantity, in order. */
  const filled = lines.flatMap((line) => {
    const sku = skuByKey.get(line.sku);
    const quantity = qtyOf(line);
    return sku && quantity > 0 ? [{ line, sku, quantity }] : [];
  });
  const totalUnits = filled.reduce((sum, row) => sum + row.quantity, 0);
  const totalAmount = filled.reduce(
    (sum, row) => sum + row.quantity * (priceOf(row.line) ?? 0),
    0,
  );

  function patchLine(id: number, patch: Partial<LotLine>) {
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    );
  }

  /** Choosing a size resets the lot (preselecting a lone lot) and the price. */
  function chooseSku(id: number, key: string) {
    const sku = skuByKey.get(key);
    setLines((current) =>
      current.map((line) => {
        if (line.id !== id) return line;
        let lot = ANY_LOT;
        if (sku?.lotTracked) {
          const free = sku.lots.filter(
            (candidate) =>
              !current.some(
                (other) =>
                  other.id !== id && other.sku === key && other.lot === candidate.harvestLotId,
              ),
          );
          // One lot to choose from is no choice: take it. With "any lot"
          // allowed the escape hatch stays the default instead.
          if (!allowAnyLot && free.length === 1) lot = free[0].harvestLotId;
        }
        return {
          ...line,
          sku: key,
          lot,
          qty: "",
          price: sku && defaultPrice ? defaultPrice(sku) : line.price,
        };
      }),
    );
  }

  function addLine() {
    setLines((current) => [...current, blankLine()]);
  }

  function removeLine(id: number) {
    setLines((current) =>
      current.length === 1 ? [blankLine()] : current.filter((line) => line.id !== id),
    );
  }

  // Stable, so a form can reset on open from an effect.
  const reset = React.useCallback(() => setLines([blankLine()]), [blankLine]);

  return {
    lines,
    setLines,
    skuByKey,
    sellable,
    allowAnyLot,
    pricing: defaultPrice != null,
    errors,
    hasErrors: errors.size > 0,
    filled,
    totalUnits,
    totalAmount,
    skuLeftFor,
    lotLeftFor,
    capOf,
    lotOptions,
    skuOptions,
    patchLine,
    chooseSku,
    addLine,
    removeLine,
    reset,
  };
}

export type LotLinesState = ReturnType<typeof useLotLines>;

/**
 * The rows. Labels are visible once as column headings on wide screens and
 * carried by aria-labels ("Line 1 size", "Line 1 varietal", …) so a row that
 * stacks on a phone is still named.
 */
export function LotLinesEditor({
  state,
  skus,
  where,
  idPrefix,
  lineTestId,
  emptyText,
  sizeHint,
}: {
  state: LotLinesState;
  skus: ShelfSku[];
  /** Where counts are measured, e.g. "at home". */
  where: string;
  /** Prefix for element ids, unique per form. */
  idPrefix: string;
  lineTestId?: string;
  emptyText?: React.ReactNode;
  /** Extra text after a size label in its option (e.g. "· 44 oz"). */
  sizeHint?: (sku: ShelfSku) => string;
}) {
  const { lines, skuByKey, allowAnyLot, pricing, errors } = state;
  if (skus.every((sku) => state.sellable(sku) === 0)) {
    return (
      <p className="text-sm text-muted-foreground">
        {emptyText ?? `Nothing with a lot is on hand ${where}.`}
      </p>
    );
  }
  const unattributed = allowAnyLot
    ? []
    : skus.filter((sku) => sku.lotTracked && sku.unattributed > 0);
  const columns = pricing
    ? "sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_4.5rem_5.5rem_4.5rem_2.25rem]"
    : "sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_5rem_2.25rem]";
  return (
    <div className="grid gap-2">
      <div
        aria-hidden
        className={cn(
          "hidden gap-2 text-xs font-medium text-muted-foreground sm:grid",
          columns,
        )}
      >
        <span>Size</span>
        <span>Varietal / lot</span>
        <span>Units</span>
        {pricing && <span>Unit price</span>}
        {pricing && <span className="text-right">Total</span>}
        <span />
      </div>
      {lines.map((line, index) => {
        const sku = skuByKey.get(line.sku);
        const cap = state.capOf(line);
        const n = index + 1;
        const lineError = errors.get(line.id);
        const sizeOptions = state.skuOptions(line);
        const lotOptions = state.lotOptions(line);
        const lotTracked = sku?.lotTracked ?? true;
        const lineTotal = qtyOf(line) * (priceOf(line) ?? 0);
        return (
          <div key={line.id} data-testid={lineTestId} className="grid gap-1">
            <div className={cn("grid grid-cols-6 items-center gap-2", columns)}>
              <div className="col-span-6 sm:col-span-1">
                <Select value={line.sku} onValueChange={(value) => state.chooseSku(line.id, value)}>
                  <SelectTrigger id={`${idPrefix}-size-${line.id}`} aria-label={`Line ${n} size`} className="w-full">
                    <SelectValue placeholder="Size" />
                  </SelectTrigger>
                  <SelectContent>
                    {sizeOptions.map(({ sku: row, left }) => (
                      <SelectItem key={row.key} value={row.key}>
                        {row.label}
                        {sizeHint ? sizeHint(row) : ""}
                        <span className="text-xs text-muted-foreground">{` · ${left} left ${where}`}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-6 sm:col-span-1">
                {sku && !lotTracked ? (
                  <p className="truncate px-1 text-xs text-muted-foreground">Not tracked by lot</p>
                ) : (
                  <Select
                    value={line.lot === ANY_LOT && allowAnyLot ? "any" : line.lot}
                    onValueChange={(value) => {
                      // Radix's hidden native <select> reports "" when the
                      // value is set (a preselected lone lot) in the same
                      // render its option first appears. No item has the
                      // value "", so "" is never a choice: ignore it rather
                      // than wipe the preselection.
                      if (value === "") return;
                      state.patchLine(line.id, { lot: value === "any" ? ANY_LOT : value });
                    }}
                    disabled={!sku}
                  >
                    <SelectTrigger
                      id={`${idPrefix}-lot-${line.id}`}
                      aria-label={`Line ${n} varietal`}
                      aria-invalid={sku && !allowAnyLot && line.lot === ANY_LOT && qtyOf(line) > 0 ? true : undefined}
                      className="w-full"
                    >
                      <SelectValue
                        placeholder={allowAnyLot ? "Any lot (oldest first)" : "Varietal / lot"}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {allowAnyLot && (
                        <SelectItem value="any">
                          Any lot (oldest first)
                          {sku && (
                            <span className="text-xs text-muted-foreground">
                              {` · ${state.skuLeftFor(line, sku)} left`}
                            </span>
                          )}
                        </SelectItem>
                      )}
                      {lotOptions.map(({ lot, left }) => (
                        <SelectItem key={lot.harvestLotId} value={lot.harvestLotId}>
                          {lotLabel(lot)}
                          <span className="text-xs text-muted-foreground">{` · ${left} left`}</span>
                        </SelectItem>
                      ))}
                      {!allowAnyLot && lotOptions.length === 0 && (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
                          No lot of this size has jars left {where}.
                        </div>
                      )}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div className={pricing ? "col-span-2 sm:col-span-1" : "col-span-5 sm:col-span-1"}>
                <Input
                  id={`${idPrefix}-qty-${line.id}`}
                  aria-label={`Line ${n} quantity`}
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max={cap}
                  disabled={!sku}
                  value={line.qty}
                  placeholder={sku ? `≤ ${cap}` : "Units"}
                  aria-invalid={lineError ? true : undefined}
                  aria-describedby={lineError ? `${idPrefix}-error-${line.id}` : undefined}
                  onChange={(event) => state.patchLine(line.id, { qty: event.target.value })}
                />
              </div>
              {pricing && (
                <div className="relative col-span-2 sm:col-span-1">
                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    $
                  </span>
                  <Input
                    className="pl-6"
                    id={`${idPrefix}-price-${line.id}`}
                    aria-label={`Line ${n} unit price`}
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    disabled={!sku}
                    placeholder="0.00"
                    value={line.price}
                    onChange={(event) => state.patchLine(line.id, { price: event.target.value })}
                  />
                </div>
              )}
              {pricing && (
                <p className="col-span-1 text-right text-sm tabular-nums text-muted-foreground" aria-label={`Line ${n} total`}>
                  {formatMoney(lineTotal)}
                </p>
              )}
              <div className="col-span-1 flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove line ${n}`}
                  disabled={lines.length === 1 && !line.sku}
                  onClick={() => state.removeLine(line.id)}
                >
                  <X />
                </Button>
              </div>
            </div>
            {lineError && (
              <p id={`${idPrefix}-error-${line.id}`} role="alert" className="text-xs text-destructive">
                Line {n}: {lineError}
              </p>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button type="button" variant="outline" size="sm" onClick={state.addLine}>
          <Plus />
          Add a line
        </Button>
        {unattributed.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {unattributed.map((sku) => `${sku.unattributed} ${sku.label}`).join(", ")}{" "}
            {where} carry no lot, so they cannot be sold or given away from here.
          </p>
        )}
      </div>
    </div>
  );
}
