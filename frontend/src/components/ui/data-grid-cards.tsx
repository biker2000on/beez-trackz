"use client";

/**
 * Mobile presentation for DataGrid, following gnucash-web's (Folio's)
 * responsive tables: below the `md` breakpoint a table becomes a stack of
 * cards, each card one row, each field a label/value line. The grid decides
 * which mode to render with `useBelowMd()` — only one mode is ever in the
 * DOM, so stateful cells (dialogs, inline inputs) are never duplicated.
 *
 * What goes where on a card comes from the column's `meta.card`:
 * - "title"    — the card's heading (default: the first column);
 * - "subtitle" — muted lines under the title;
 * - "badge"    — pills beside the title;
 * - "actions"  — row menus/buttons, top right (default for columns with id
 *                `actions`/`menu`);
 * - "field"    — a label/value line (default);
 * - "hidden"   — desktop only.
 *
 * In a selectable grid each card gets the row checkbox in a leading column
 * and a tinted, `data-state="selected"` look while selected; a tap uses the
 * same click rules as a table row.
 */

import * as React from "react";
import { FlexRender } from "@tanstack/react-table";
import type { Cell, Column, RowData, TableFeatures } from "@tanstack/react-table";

import { cn } from "@/lib/utils";

export type DataGridCardRole =
  | "title"
  | "subtitle"
  | "badge"
  | "actions"
  | "field"
  | "hidden";

const BELOW_MD_QUERY = "(max-width: 767.98px)";

function subscribeBelowMd(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const media = window.matchMedia(BELOW_MD_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/**
 * True below Tailwind's `md` breakpoint. The server snapshot is "desktop", so
 * a phone hydrates the table and swaps to cards straight after — no mismatch.
 */
export function useBelowMd(): boolean {
  return React.useSyncExternalStore(
    subscribeBelowMd,
    () =>
      typeof window !== "undefined" && !!window.matchMedia
        ? window.matchMedia(BELOW_MD_QUERY).matches
        : false,
    () => false,
  );
}

/** The human label of a column: `meta.label`, else a string header, else "". */
export function columnLabel<TFeatures extends TableFeatures, TData extends RowData>(
  column: Column<TFeatures, TData, unknown>,
): string {
  const meta = column.columnDef.meta as { label?: string } | undefined;
  if (meta?.label) return meta.label;
  const header = column.columnDef.header;
  return typeof header === "string" ? header : "";
}

/** Resolves a column's card role, applying the defaults described above. */
export function cardRole<TFeatures extends TableFeatures, TData extends RowData>(
  column: Column<TFeatures, TData, unknown>,
  index: number,
  hasExplicitTitle: boolean,
): DataGridCardRole {
  const meta = column.columnDef.meta as { card?: DataGridCardRole } | undefined;
  if (meta?.card) return meta.card;
  if (!hasExplicitTitle && index === 0) return "title";
  if (/^(actions?|menu|row-actions)$/i.test(column.id)) return "actions";
  return "field";
}

interface DataGridCardProps<TFeatures extends TableFeatures, TData extends RowData> {
  cells: Cell<TFeatures, TData, unknown>[];
  roles: DataGridCardRole[];
  /**
   * Render as a bordered tile in a multi-column grid (cards shown on a wide
   * container because the table did not fit) instead of a full-width row.
   */
  tile?: boolean;
  focused: boolean;
  clickable: boolean;
  /**
   * Selection state when the grid is selectable (undefined otherwise). A
   * selected card is tinted and carries `data-state="selected"`.
   */
  selected?: boolean;
  /** Rendered in a narrow column before the card body (the row checkbox). */
  leading?: React.ReactNode;
  extra?: React.HTMLAttributes<HTMLElement>;
  onClick: (event: React.MouseEvent<HTMLLIElement>) => void;
  onMouseDown?: (event: React.MouseEvent<HTMLLIElement>) => void;
  onDoubleClick?: (event: React.MouseEvent<HTMLLIElement>) => void;
}

export function DataGridCard<TFeatures extends TableFeatures, TData extends RowData>({
  cells,
  roles,
  tile = false,
  focused,
  clickable,
  selected,
  leading,
  extra,
  onClick,
  onMouseDown,
  onDoubleClick,
}: DataGridCardProps<TFeatures, TData>) {
  const pick = (role: DataGridCardRole) =>
    cells.filter((_, index) => roles[index] === role);
  const title = pick("title");
  const subtitles = pick("subtitle");
  const badges = pick("badge");
  const actions = pick("actions");
  const fields = pick("field");

  const body = (
    <>
      {(title.length > 0 || badges.length > 0 || actions.length > 0) && (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {title.map((cell) => (
              <div key={cell.id} className="break-words font-medium">
                <FlexRender cell={cell} />
              </div>
            ))}
            {subtitles.map((cell) => (
              <div
                key={cell.id}
                className="mt-0.5 break-words text-xs text-muted-foreground"
              >
                <FlexRender cell={cell} />
              </div>
            ))}
          </div>
          {(badges.length > 0 || actions.length > 0) && (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              {badges.map((cell) => (
                <span key={cell.id}>
                  <FlexRender cell={cell} />
                </span>
              ))}
              {actions.map((cell) => (
                <span key={cell.id}>
                  <FlexRender cell={cell} />
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {fields.length > 0 && (
        <dl className="mt-2 grid gap-y-1">
          {fields.map((cell) => {
            const label = columnLabel(cell.column);
            const meta = cell.column.columnDef.meta as
              | { align?: "left" | "right" }
              | undefined;
            return label ? (
              <div
                key={cell.id}
                className="flex items-baseline justify-between gap-3"
              >
                <dt className="shrink-0 text-xs uppercase tracking-wider text-muted-foreground">
                  {label}
                </dt>
                <dd
                  className={cn(
                    "min-w-0 break-words text-right text-sm",
                    meta?.align === "right" && "tabular-nums",
                  )}
                >
                  <FlexRender cell={cell} />
                </dd>
              </div>
            ) : (
              <dd key={cell.id} className="min-w-0 break-words text-sm">
                <FlexRender cell={cell} />
              </dd>
            );
          })}
        </dl>
      )}
    </>
  );

  return (
    <li
      data-grid-row=""
      data-grid-card=""
      {...(extra as React.HTMLAttributes<HTMLLIElement> | undefined)}
      {...(selected !== undefined
        ? { "data-state": selected ? "selected" : undefined }
        : {})}
      className={cn(
        tile
          ? "rounded-lg border p-4 transition-colors"
          : "border-b p-4 transition-colors last:border-b-0",
        clickable && "cursor-pointer active:bg-muted/60",
        selected && "bg-primary/10",
        focused && "bg-primary/5 ring-2 ring-inset ring-primary/50",
        selected && focused && "bg-primary/10",
        leading != null && "flex items-start gap-3",
        extra?.className,
      )}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {leading != null ? (
        <>
          {/* Lines the checkbox up with the card title's first line. */}
          <div className="flex h-5 shrink-0 items-center">{leading}</div>
          <div className="min-w-0 flex-1">{body}</div>
        </>
      ) : (
        body
      )}
    </li>
  );
}
