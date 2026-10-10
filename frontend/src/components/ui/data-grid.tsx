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
 * Pass `selection` (from `useRowSelection`) for desktop multi-select: a
 * leading checkbox column, click selects one row, shift-click selects the
 * range from the anchor, ctrl/cmd-click toggles, Space toggles the focused
 * row, shift+arrow extends, Ctrl/Cmd+A selects every loaded row and Escape
 * clears. With a selection, a row is opened by double-click or Enter rather
 * than by a single click.
 *
 * Keystrokes inside inputs, menus, and dialogs are left alone, so editable
 * cells (e.g. physical-count drafts) and row action menus keep their native
 * behavior. Cells that must swallow a click (menus, inline inputs) can call
 * `event.stopPropagation()` — the grid only listens at the row level.
 */

import * as React from "react";
import { FlexRender, tableFeatures } from "@tanstack/react-table";
import type {
  RowData,
  Table as TanstackTable,
  TableFeatures,
} from "@tanstack/react-table";
import { Search, X } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { isTypingTarget } from "@/lib/keyboard";
import type { RowSelection } from "@/lib/use-row-selection";

/** Per-column presentation hints, carried on the column def's `meta`. */
export interface DataGridColumnMeta {
  align?: "left" | "right";
  headClassName?: string;
  cellClassName?: string;
}

/**
 * The feature set every grid uses. Pass to `useTable({ features })` and
 * `createColumnHelper<typeof dataGridFeatures, Row>()`.
 */
export const dataGridFeatures = tableFeatures({});

/**
 * Text the search box matches a row against: every string and number in the
 * row's data, nested objects included, joined and lower-cased. Grids whose
 * rows are mostly display columns still search on what the row *is*, not
 * only on what an accessor happened to expose.
 */
function rowHaystack(value: unknown, depth = 0): string {
  if (value == null || depth > 3) return "";
  if (typeof value === "string") return value.toLowerCase();
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => rowHaystack(item, depth + 1)).join(" ");
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map((item) => rowHaystack(item, depth + 1))
      .join(" ");
  }
  return "";
}

/** Every whitespace-separated term must appear somewhere in the row. */
export function rowMatchesSearch(original: unknown, search: string): boolean {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = rowHaystack(original);
  return terms.every((term) => haystack.includes(term));
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
  /**
   * Show the ledger-style search box above the table (every term must match
   * somewhere in the row's data; `/` focuses it, Escape clears it). Defaults
   * to `listenOnWindow`, so the page's primary grid is searchable and
   * secondary card grids are not.
   */
  searchable?: boolean;
  searchPlaceholder?: string;
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
  /**
   * Multi-select over the rendered rows, keyed by the table's row ids. The
   * ids given to `useRowSelection` must be the rows in display order.
   */
  selection?: RowSelection;
  /** Accessible name of the header checkbox. */
  selectAllLabel?: string;
  /** Accessible name of a row's checkbox. */
  getRowLabel?: (row: TData) => string;
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
  searchable = listenOnWindow,
  searchPlaceholder = "Search… (press / to focus)",
  "aria-label": ariaLabel,
  className,
  trailingRows,
  rowProps,
  selection,
  selectAllLabel = "Select all loaded rows",
  getRowLabel,
}: DataGridProps<TFeatures, TData>) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [focusedRowIndex, setFocusedRowIndex] = React.useState(-1);

  const canSearch = searchable;
  const [globalFilter, setGlobalFilterText] = React.useState("");
  const setGlobalFilter = (value: string) => {
    setGlobalFilterText(value);
    setFocusedRowIndex(-1);
  };

  const allRows = table.getRowModel().rows;
  const rows = React.useMemo(
    () =>
      canSearch && globalFilter.trim()
        ? allRows.filter((row) => rowMatchesSearch(row.original, globalFilter))
        : allRows,
    [allRows, canSearch, globalFilter],
  );
  const headerGroups = table.getHeaderGroups();
  const rowCount = rows.length;
  const totalCount = allRows.length;

  // The handler reads the latest rows/state through a ref so the window
  // listener is attached once, not re-bound on every data change.
  const stateRef = React.useRef({
    rowCount,
    focusedRowIndex,
    rows,
    onRowActivate,
    onRowDelete,
    selection,
  });
  React.useEffect(() => {
    stateRef.current = {
      rowCount,
      focusedRowIndex,
      rows,
      onRowActivate,
      onRowDelete,
      selection,
    };
  });

  React.useEffect(() => {
    if (!listenOnWindow) return;
    function handleKeyDown(event: KeyboardEvent) {
      const state = stateRef.current;
      if (isTypingTarget(event.target)) return;
      if (
        state.selection &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "a" &&
        !overlayOpen()
      ) {
        if (state.rowCount === 0) return;
        event.preventDefault();
        state.selection.selectAll();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (overlayOpen()) return;
      if (event.key === "/" && searchRef.current) {
        event.preventDefault();
        searchRef.current.focus();
        searchRef.current.select();
        return;
      }
      if (state.rowCount === 0) return;

      const move = (next: number) => {
        event.preventDefault();
        const clamped = Math.max(0, Math.min(state.rowCount - 1, next));
        setFocusedRowIndex(clamped);
        // Shift+movement extends the selection from its anchor (or from the
        // row focus is leaving) to the newly focused row.
        if (event.shiftKey && state.selection) {
          const target = state.rows[clamped];
          if (target) {
            state.selection.extend(
              state.rows[state.focusedRowIndex]?.id ?? null,
              target.id,
            );
          }
        }
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
        case " ":
        case "Spacebar": {
          const row = state.rows[state.focusedRowIndex];
          if (!row || !state.selection) break;
          // A focused checkbox, button or link handles its own Space.
          if (
            event.target instanceof Element &&
            event.target.closest("button, a, [role=checkbox]")
          ) {
            break;
          }
          event.preventDefault();
          state.selection.toggle(row.id, event.shiftKey);
          break;
        }
        case "Escape":
          if (state.selection && state.selection.count > 0) {
            state.selection.clear();
          }
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
      className={cn("relative w-full min-w-0 max-w-full overflow-x-auto", className)}
    >
      {canSearch && (
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              ref={searchRef}
              type="search"
              value={globalFilter}
              onChange={(event) => setGlobalFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  if (globalFilter) setGlobalFilter("");
                  else event.currentTarget.blur();
                }
              }}
              placeholder={searchPlaceholder}
              aria-label={ariaLabel ? `Search ${ariaLabel}` : "Search rows"}
              className="h-8 w-full rounded-md border border-input bg-transparent pl-8 pr-8 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
            />
            {globalFilter && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setGlobalFilter("");
                  searchRef.current?.focus();
                }}
                className="absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {globalFilter ? `${rowCount} of ${totalCount}` : `${totalCount} rows`}
          </span>
        </div>
      )}
      <table
        aria-label={ariaLabel}
        className="w-full caption-bottom text-sm"
      >
        <thead className="[&_tr]:border-b">
          {headerGroups.map((headerGroup) => (
            <tr key={headerGroup.id}>
              {selection && (
                <th className="h-10 w-10 px-3 align-middle">
                  <Checkbox
                    checked={
                      selection.allSelected
                        ? true
                        : selection.count > 0
                          ? "indeterminate"
                          : false
                    }
                    disabled={rowCount === 0}
                    aria-label={selectAllLabel}
                    onClick={(event) => {
                      event.preventDefault();
                      if (selection.allSelected) selection.clear();
                      else selection.selectAll();
                    }}
                  />
                </th>
              )}
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
            const rowSelected = selection?.isSelected(row.id) ?? false;
            return (
              <React.Fragment key={row.id}>
                {showGroupHeader && (
                  <tr className="border-b bg-muted/50">
                    <td
                      colSpan={row.getAllCells().length + (selection ? 1 : 0)}
                      className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      {renderGroupHeader ? renderGroupHeader(group) : group}
                    </td>
                  </tr>
                )}
                <tr
                  data-grid-row=""
                  {...extra}
                  {...(selection
                    ? {
                        "aria-selected": rowSelected,
                        "data-state": rowSelected ? "selected" : undefined,
                      }
                    : {})}
                  className={cn(
                    "group border-b transition-colors hover:bg-muted/40",
                    (onRowActivate || selection) && "cursor-pointer",
                    rowSelected && "bg-primary/10 hover:bg-primary/15",
                    rowIndex === focusedRowIndex &&
                      "bg-primary/5 ring-2 ring-inset ring-primary/50",
                    rowSelected &&
                      rowIndex === focusedRowIndex &&
                      "bg-primary/10",
                    extra?.className,
                  )}
                  onMouseDown={(event) => {
                    extra?.onMouseDown?.(event);
                    // Shift-click selects a range; keep the browser from
                    // also highlighting the text in between.
                    if (selection && event.shiftKey) event.preventDefault();
                  }}
                  onClick={(event) => {
                    extra?.onClick?.(event);
                    if (event.defaultPrevented) return;
                    setFocusedRowIndex(rowIndex);
                    if (selection) {
                      selection.click(row.id, {
                        shift: event.shiftKey,
                        toggle: event.ctrlKey || event.metaKey,
                      });
                      return;
                    }
                    onRowActivate?.(row.original);
                  }}
                  onDoubleClick={(event) => {
                    extra?.onDoubleClick?.(event);
                    if (event.defaultPrevented || !selection || !onRowActivate) return;
                    if (event.shiftKey || event.ctrlKey || event.metaKey) return;
                    onRowActivate(row.original);
                  }}
                >
                  {selection && (
                    <td className="w-10 px-3 align-middle">
                      <Checkbox
                        checked={rowSelected}
                        tabIndex={-1}
                        aria-label={
                          getRowLabel ? getRowLabel(row.original) : "Select row"
                        }
                        onClick={(event) => {
                          // The checkbox toggles (shift adds the range from
                          // the anchor); it never collapses the selection
                          // the way a plain row click does.
                          event.preventDefault();
                          event.stopPropagation();
                          setFocusedRowIndex(rowIndex);
                          selection.toggle(row.id, event.shiftKey);
                        }}
                        onMouseDown={(event) => {
                          if (event.shiftKey) event.preventDefault();
                        }}
                      />
                    </td>
                  )}
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
          {canSearch && globalFilter && rowCount === 0 && (
            <tr>
              <td
                colSpan={table.getAllLeafColumns().length + (selection ? 1 : 0)}
                className="px-3 py-6 text-center text-sm text-muted-foreground"
              >
                No rows match &ldquo;{globalFilter}&rdquo;.
              </td>
            </tr>
          )}
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
