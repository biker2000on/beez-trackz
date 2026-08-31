"use client";

/**
 * Keyboard-navigable table built on TanStack Table v9, following the ledger
 * interaction pattern from gnucash-web's AccountLedger:
 *
 * - one shared column model, so every section of a grouped table lines up;
 * - a focused-row index driven by a window-level keydown listener — ArrowDown/
 *   ArrowUp (and j/k) move, Home/End jump, Enter activates the focused row,
 *   Escape clears focus;
 * - the focused row is highlighted with an inset primary ring and rows are
 *   click-to-activate.
 *
 * Keystrokes inside inputs, menus, and dialogs are left alone, so editable
 * cells (e.g. physical-count drafts) and row action menus keep their native
 * behavior. Cells that must swallow a click (menus, inline inputs) can call
 * `event.stopPropagation()` — the grid only listens at the row level.
 */

import * as React from "react";
import { FlexRender } from "@tanstack/react-table";
import type {
  RowData,
  Table as TanstackTable,
  TableFeatures,
} from "@tanstack/react-table";

import { cn } from "@/lib/utils";
import { isTypingTarget } from "@/lib/keyboard";

/** Per-column presentation hints, carried on the column def's `meta`. */
export interface DataGridColumnMeta {
  align?: "left" | "right";
  headClassName?: string;
  cellClassName?: string;
}

interface DataGridProps<
  TFeatures extends TableFeatures,
  TData extends RowData,
> {
  table: TanstackTable<TFeatures, TData>;
  /**
   * Group key per row. Consecutive rows sharing a key render under one full
   * width section header; keep the data pre-sorted by this key.
   */
  getRowGroup?: (row: TData) => string;
  renderGroupHeader?: (key: string) => React.ReactNode;
  /** Called on Enter or click on a row. */
  onRowActivate?: (row: TData) => void;
  /** Called on Delete/Backspace on the focused row. */
  onRowDelete?: (row: TData) => void;
  /**
   * Keyboard listening is window-level (like the gnucash-web ledger) so the
   * grid responds without needing focus first. Set false on pages that render
   * more than one grid and wire the second grid's shortcuts yourself.
   */
  listenOnWindow?: boolean;
  "aria-label"?: string;
  className?: string;
  /**
   * Extra `<tr>` rows appended after the data rows (totals, summary lines).
   * They are outside keyboard navigation.
   */
  trailingRows?: React.ReactNode;
  /**
   * Extra attributes merged onto each data `<tr>` — tabIndex, aria-selected,
   * per-row key handlers. A handler that calls `event.preventDefault()` stops
   * the grid's own row click/activation for that event.
   */
  rowProps?: (
    row: TData,
    rowIndex: number,
  ) => React.HTMLAttributes<HTMLTableRowElement> | undefined;
}

/** True while any modal-ish layer is open; the grid must not steal its keys. */
function overlayOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"]',
    ) != null
  );
}

export function DataGrid<
  TFeatures extends TableFeatures,
  TData extends RowData,
>({
  table,
  getRowGroup,
  renderGroupHeader,
  onRowActivate,
  onRowDelete,
  listenOnWindow = true,
  "aria-label": ariaLabel,
  className,
  trailingRows,
  rowProps,
}: DataGridProps<TFeatures, TData>) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [focusedRowIndex, setFocusedRowIndex] = React.useState(-1);

  const rows = table.getRowModel().rows;
  const headerGroups = table.getHeaderGroups();
  const rowCount = rows.length;

  // The handler reads the latest rows/state through a ref so the window
  // listener is attached once, not re-bound on every data change.
  const stateRef = React.useRef({
    rowCount,
    focusedRowIndex,
    rows,
    onRowActivate,
    onRowDelete,
  });
  React.useEffect(() => {
    stateRef.current = {
      rowCount,
      focusedRowIndex,
      rows,
      onRowActivate,
      onRowDelete,
    };
  });

  React.useEffect(() => {
    if (!listenOnWindow) return;
    function handleKeyDown(event: KeyboardEvent) {
      const state = stateRef.current;
      if (state.rowCount === 0) return;
      if (isTypingTarget(event.target)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (overlayOpen()) return;

      const move = (next: number) => {
        event.preventDefault();
        const clamped = Math.max(0, Math.min(state.rowCount - 1, next));
        setFocusedRowIndex(clamped);
        containerRef.current
          ?.querySelectorAll("tbody tr[data-grid-row]")
          [clamped]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      };

      switch (event.key) {
        case "ArrowDown":
        case "Down":
        case "j":
          move(state.focusedRowIndex + 1);
          break;
        case "ArrowUp":
        case "Up":
        case "k":
          move(state.focusedRowIndex - 1);
          break;
        case "Home":
          move(0);
          break;
        case "End":
          move(state.rowCount - 1);
          break;
        case "PageDown":
          move(state.focusedRowIndex + 10);
          break;
        case "PageUp":
          move(state.focusedRowIndex - 10);
          break;
        case "Enter": {
          const row = state.rows[state.focusedRowIndex];
          if (row && state.onRowActivate) {
            event.preventDefault();
            state.onRowActivate(row.original);
          }
          break;
        }
        case "Delete":
        case "Backspace": {
          const row = state.rows[state.focusedRowIndex];
          if (row && state.onRowDelete) {
            event.preventDefault();
            state.onRowDelete(row.original);
          }
          break;
        }
        case "Escape":
          setFocusedRowIndex(-1);
          break;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [listenOnWindow]);

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full overflow-x-auto", className)}
    >
      <table
        aria-label={ariaLabel}
        className="w-full caption-bottom text-sm"
      >
        <thead className="[&_tr]:border-b">
          {headerGroups.map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const meta = header.column.columnDef.meta as
                  | DataGridColumnMeta
                  | undefined;
                return (
                  <th
                    key={header.id}
                    colSpan={header.colSpan}
                    className={cn(
                      "h-10 whitespace-nowrap px-3 text-left align-middle font-medium text-muted-foreground",
                      meta?.align === "right" && "text-right",
                      meta?.headClassName,
                    )}
                  >
                    {header.isPlaceholder ? null : (
                      <FlexRender header={header} />
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody className="[&_tr:last-child]:border-0">
          {rows.map((row, rowIndex) => {
            const extra = rowProps?.(row.original, rowIndex);
            const group = getRowGroup?.(row.original);
            const previousGroup =
              rowIndex > 0 ? getRowGroup?.(rows[rowIndex - 1].original) : undefined;
            const showGroupHeader =
              group !== undefined && group !== previousGroup;
            return (
              <React.Fragment key={row.id}>
                {showGroupHeader && (
                  <tr className="border-b bg-muted/50">
                    <td
                      colSpan={row.getAllCells().length}
                      className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      {renderGroupHeader ? renderGroupHeader(group) : group}
                    </td>
                  </tr>
                )}
                <tr
                  data-grid-row=""
                  {...extra}
                  className={cn(
                    "group border-b transition-colors hover:bg-muted/40",
                    onRowActivate && "cursor-pointer",
                    rowIndex === focusedRowIndex &&
                      "bg-primary/5 ring-2 ring-inset ring-primary/50",
                    extra?.className,
                  )}
                  onClick={(event) => {
                    extra?.onClick?.(event);
                    if (event.defaultPrevented) return;
                    setFocusedRowIndex(rowIndex);
                    onRowActivate?.(row.original);
                  }}
                >
                  {row.getAllCells().map((cell) => {
                    const meta = cell.column.columnDef.meta as
                      | DataGridColumnMeta
                      | undefined;
                    return (
                      <td
                        key={cell.id}
                        className={cn(
                          "whitespace-nowrap p-3 align-middle",
                          meta?.align === "right" && "text-right",
                          meta?.cellClassName,
                        )}
                      >
                        <FlexRender cell={cell} />
                      </td>
                    );
                  })}
                </tr>
              </React.Fragment>
            );
          })}
          {trailingRows}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Stops a click inside a cell (row menu, inline input) from activating the
 * row. Wrap interactive cell content in this.
 */
export function DataGridCellAction({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={className}
      onClick={(event) => event.stopPropagation()}
      {...props}
    />
  );
}
