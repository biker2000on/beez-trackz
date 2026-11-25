"use client";

/**
 * The apiary's hives laid out the way they stand: position labels A1–D4 become
 * rows A–D and columns 1–4. Labels that are not a letter plus a number (a nuc
 * placement such as "B2 (N1)") follow the grid in their own row. Every cell is
 * a 44px button, so it works with gloves on.
 *
 * Callers pass active hives only (`activeHives` in `lib/hive-label.ts`) and a
 * `labelFor` built on `hiveDisplayLabel`, so a reused label never shows twice.
 */

import * as React from "react";

import { cn } from "@/lib/utils";

export interface GridHive {
  id: string;
  positionLabel: string;
}

const GRID_LABEL = /^([A-Za-z])\s*-?\s*(\d{1,2})$/;
const MAX_COLUMNS = 8;

interface Layout<T> {
  rows: { letter: string; cells: (T | null)[] }[];
  columns: number;
  other: T[];
}

export function hiveGridLayout<T extends GridHive>(hives: readonly T[]): Layout<T> {
  const placed = new Map<string, Map<number, T>>();
  const other: T[] = [];
  let columns = 0;
  for (const hive of hives) {
    const match = GRID_LABEL.exec(hive.positionLabel.trim());
    const column = match ? Number(match[2]) : 0;
    if (!match || column < 1 || column > MAX_COLUMNS) {
      other.push(hive);
      continue;
    }
    const letter = match[1].toUpperCase();
    const row = placed.get(letter) ?? new Map<number, T>();
    if (row.has(column)) {
      other.push(hive);
      continue;
    }
    row.set(column, hive);
    placed.set(letter, row);
    columns = Math.max(columns, column);
  }
  const rows = [...placed.keys()].sort().map((letter) => {
    const row = placed.get(letter)!;
    return {
      letter,
      cells: Array.from({ length: columns }, (_, index) => row.get(index + 1) ?? null),
    };
  });
  other.sort((a, b) =>
    a.positionLabel.localeCompare(b.positionLabel, undefined, { numeric: true }),
  );
  return { rows, columns, other };
}

/** Grid order (row by row), the order a beekeeper walks the yard. */
export function hiveGridOrder<T extends GridHive>(hives: readonly T[]): T[] {
  const layout = hiveGridLayout(hives);
  return [
    ...layout.rows.flatMap((row) => row.cells.filter((cell): cell is T => cell !== null)),
    ...layout.other,
  ];
}

export function HiveGridPicker<T extends GridHive>({
  hives,
  selected,
  onSelect,
  labelFor,
  noteFor,
  legend,
  hideLegend,
  disabled,
  emptyText = "No active hives in this apiary.",
}: {
  hives: readonly T[];
  /** Selected ids. A single picker passes a set of zero or one. */
  selected: ReadonlySet<string>;
  onSelect: (hive: T) => void;
  /** Full name for screen readers and tooltips (e.g. "A4 · since May 2026"). */
  labelFor: (hive: T) => string;
  /** A short second line inside the cell, such as "in row 3". */
  noteFor?: (hive: T) => string | undefined;
  legend: string;
  hideLegend?: boolean;
  disabled?: boolean;
  emptyText?: string;
}) {
  const layout = React.useMemo(() => hiveGridLayout(hives), [hives]);
  if (hives.length === 0)
    return <p className="text-sm text-muted-foreground">{emptyText}</p>;

  const cell = (hive: T) => {
    const pressed = selected.has(hive.id);
    const name = labelFor(hive);
    const note = noteFor?.(hive);
    return (
      <button
        key={hive.id}
        type="button"
        disabled={disabled}
        aria-pressed={pressed}
        aria-label={note ? `${name}, ${note}` : name}
        title={name !== hive.positionLabel ? name : undefined}
        onClick={() => onSelect(hive)}
        className={cn(
          "flex min-h-11 min-w-11 flex-col items-center justify-center rounded-md border px-1 py-1 text-sm font-semibold tabular-nums transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-50",
          pressed
            ? "border-primary bg-primary text-primary-foreground"
            : "bg-background hover:bg-secondary",
        )}
      >
        <span>{hive.positionLabel}</span>
        {note ? (
          <span
            className={cn(
              "text-[11px] font-normal leading-tight",
              pressed ? "text-primary-foreground/85" : "text-muted-foreground",
            )}
          >
            {note}
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <fieldset className="grid min-w-0 gap-2">
      <legend className={cn("mb-1 text-sm font-medium", hideLegend && "sr-only")}>
        {legend}
      </legend>
      {layout.rows.length > 0 ? (
        <div className="overflow-x-auto">
          <div
            className="grid gap-1.5"
            style={{
              gridTemplateColumns: `repeat(${layout.columns}, minmax(2.75rem, 1fr))`,
            }}
          >
            {layout.rows.flatMap((row) =>
              row.cells.map((hive, index) =>
                hive ? (
                  cell(hive)
                ) : (
                  <span
                    key={`${row.letter}-${index}`}
                    className="flex min-h-11 flex-col items-center justify-center rounded-md border border-dashed border-border px-1 py-1 text-sm tabular-nums text-muted-foreground"
                  >
                    <span>{`${row.letter}${index + 1}`}</span>
                    <span className="text-[11px] leading-tight">empty</span>
                  </span>
                ),
              ),
            )}
          </div>
        </div>
      ) : null}
      {layout.other.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">{layout.other.map(cell)}</div>
      ) : null}
    </fieldset>
  );
}
