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
 * Columns built with an accessor are sortable (click the header; on phones a
 * "Sort by" select), columns whose meta sets `filter` get a select of their
 * distinct values above the grid, and below the `md` breakpoint every grid
 * renders its rows as cards (see ./data-grid-cards.tsx) — one row per card,
 * one label/value line per column, laid out by `meta.card`.
 *
 * Keystrokes inside inputs, menus, and dialogs are left alone, so editable
 * cells (e.g. physical-count drafts) and row action menus keep their native
 * behavior. Cells that must swallow a click (menus, inline inputs) can call
 * `event.stopPropagation()` — the grid only listens at the row level.
 */

import * as React from "react";
import {
  FlexRender,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
} from "@tanstack/react-table";
import type {
  Column,
  Row,
  RowData,
  Table as TanstackTable,
  TableFeatures,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { isTypingTarget } from "@/lib/keyboard";

import {
  DataGridCard,
  type DataGridCardRole,
  cardRole,
  columnLabel,
  useBelowMd,
} from "./data-grid-cards";

export type { DataGridCardRole } from "./data-grid-cards";

/** Per-column presentation hints, carried on the column def's `meta`. */
export interface DataGridColumnMeta<TData = unknown> {
  align?: "left" | "right";
  headClassName?: string;
  cellClassName?: string;
  /**
   * Human name used by the mobile card, the sort select and the filter
   * select. Defaults to the header when the header is a string.
   */
  label?: string;
  /** Where this column goes on the mobile card (see data-grid-cards.tsx). */
  card?: DataGridCardRole;
  /**
   * Adds a select above the grid listing every distinct value of this column;
   * picking one keeps only rows with that value. Values come from
   * `filterValue` when given, else from the column's accessor.
   */
  filter?: boolean;
  filterValue?: (row: TData) => string | null | undefined;
  /** Label of the filter select's "everything" option. */
  filterAllLabel?: string;
}

/**
 * The feature set every grid uses. Pass to `useTable({ features })` and
 * `createColumnHelper<typeof dataGridFeatures, Row>()`. Sorting is on for
 * every accessor column (display columns have no value to sort by).
 */
export const dataGridFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    text: sortFn_text,
    datetime: sortFn_datetime,
    basic: sortFn_basic,
  },
});

type GridFeatures = typeof dataGridFeatures;
type GridColumn<TData extends RowData> = Column<GridFeatures, TData, unknown>;

/** Sentinel filter value for rows whose value is empty. */
const EMPTY_FILTER_VALUE = "__none__";

function filterValueOf<TData extends RowData>(
  row: Row<GridFeatures, TData>,
  column: GridColumn<TData>,
): string {
  const meta = column.columnDef.meta as DataGridColumnMeta<TData> | undefined;
  const raw = meta?.filterValue
    ? meta.filterValue(row.original)
    : column.accessorFn
      ? row.getValue(column.id)
      : undefined;
  if (raw == null) return EMPTY_FILTER_VALUE;
  const text = String(raw).trim();
  return text === "" ? EMPTY_FILTER_VALUE : text;
}

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
   * width section header; keep the data pre-sorted by this key. Headers are
   * dropped while the user sorts by a column, since groups no longer hold.
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
   * They are outside keyboard navigation. In card mode they render in a
   * small table under the cards unless `trailingCard` is given.
   */
  trailingRows?: React.ReactNode;
  /** Card-mode replacement for `trailingRows`. */
  trailingCard?: React.ReactNode;
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
   * "auto" (default) renders cards below the `md` breakpoint; "never" keeps
   * the table everywhere (wide matrices that read better scrolled).
   */
  cardMode?: "auto" | "never" | "always";
  /** Extra controls placed in the toolbar beside search and filters. */
  toolbar?: React.ReactNode;
  /** Shown instead of an empty body when the grid has no rows at all. */
  emptyMessage?: React.ReactNode;
}

/** True while any modal-ish layer is open; the grid must not steal its keys. */
function overlayOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"]',
    ) != null
  );
}

const selectClassName =
  "h-8 min-w-0 max-w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function DataGrid<
  TFeatures extends TableFeatures,
  TData extends RowData,
>({
  table: tableProp,
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
  trailingCard,
  rowProps,
  cardMode = "auto",
  toolbar,
  emptyMessage,
}: DataGridProps<TFeatures, TData>) {
  // Every grid is built with `dataGridFeatures`; the generic stays loose so
  // callers keep their own inferred table type.
  const table = tableProp as unknown as TanstackTable<GridFeatures, TData>;
  const containerRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [focusedRowIndex, setFocusedRowIndex] = React.useState(-1);
  const belowMd = useBelowMd();
  const asCards = cardMode === "always" || (cardMode === "auto" && belowMd);

  const canSearch = searchable;
  const [globalFilter, setGlobalFilterText] = React.useState("");
  const setGlobalFilter = (value: string) => {
    setGlobalFilterText(value);
    setFocusedRowIndex(-1);
  };
  const [columnFilters, setColumnFilters] = React.useState<
    Record<string, string>
  >({});

  const leafColumns = table.getAllLeafColumns() as GridColumn<TData>[];
  const filterColumns = leafColumns.filter(
    (column) =>
      (column.columnDef.meta as DataGridColumnMeta | undefined)?.filter,
  );
  const sortableColumns = leafColumns.filter(
    (column) =>
      typeof column.getCanSort === "function" && column.getCanSort(),
  );
  const sorting = table.store?.state?.sorting ?? [];
  const isSorted = sorting.length > 0;

  const allRows = table.getRowModel().rows;
  const activeFilters = Object.entries(columnFilters).filter(
    ([, value]) => value !== "",
  );
  // Grids hold at most a few hundred rows; filtering each render is cheap and
  // keeps the row list in step with whatever the table's sort produced.
  let rows = allRows;
  if (activeFilters.length > 0) {
    rows = rows.filter((row) =>
      activeFilters.every(([id, value]) => {
        const column = leafColumns.find((col) => col.id === id);
        return !column || filterValueOf(row, column) === value;
      }),
    );
  }
  if (canSearch && globalFilter.trim()) {
    rows = rows.filter((row) => rowMatchesSearch(row.original, globalFilter));
  }
  const filterOptions = filterColumns.map((column) => {
    const values = new Set<string>();
    for (const row of allRows) values.add(filterValueOf(row, column));
    const options = [...values]
      .filter((value) => value !== EMPTY_FILTER_VALUE)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return { column, options, hasEmpty: values.has(EMPTY_FILTER_VALUE) };
  }).filter(
    // A filter with one choice filters nothing; keep it only while it is set.
    ({ column, options, hasEmpty }) =>
      options.length + (hasEmpty ? 1 : 0) > 1 || Boolean(columnFilters[column.id]),
  );
  const headerGroups = table.getHeaderGroups();
  const rowCount = rows.length;
  const totalCount = allRows.length;
  const narrowed = Boolean(globalFilter.trim()) || activeFilters.length > 0;

  function setSort(value: string) {
    if (typeof table.setSorting !== "function") return;
    setFocusedRowIndex(-1);
    if (!value) {
      table.setSorting([]);
      return;
    }
    const [id, direction] = value.split(":");
    table.setSorting([{ id, desc: direction === "desc" }]);
  }

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
      if (isTypingTarget(event.target)) return;
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
        containerRef.current
          ?.querySelectorAll("[data-grid-row]")
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

  const showSortSelect = asCards && sortableColumns.length > 0;
  const showToolbar =
    canSearch || filterOptions.length > 0 || showSortSelect || toolbar != null;
  const sortValue = sorting[0]
    ? `${sorting[0].id}:${sorting[0].desc ? "desc" : "asc"}`
    : "";

  const groupFor = (row: TData) => (isSorted ? undefined : getRowGroup?.(row));

  const noMatch = narrowed && rowCount === 0 && totalCount > 0;
  const emptyText = noMatch
    ? globalFilter.trim()
      ? <>No rows match &ldquo;{globalFilter}&rdquo;.</>
      : "No rows match these filters."
    : totalCount === 0
      ? emptyMessage
      : null;

  // Card roles are a function of the column model only.
  const hasExplicitTitle = leafColumns.some(
    (column) =>
      (column.columnDef.meta as DataGridColumnMeta | undefined)?.card ===
      "title",
  );
  const roles = leafColumns.map((column, index) =>
    cardRole(column, index, hasExplicitTitle),
  );

  const activate = (
    event: React.MouseEvent<HTMLElement>,
    extra: React.HTMLAttributes<HTMLElement> | undefined,
    row: Row<GridFeatures, TData>,
    rowIndex: number,
  ) => {
    (extra?.onClick as ((e: React.MouseEvent<HTMLElement>) => void) | undefined)?.(
      event,
    );
    if (event.defaultPrevented) return;
    setFocusedRowIndex(rowIndex);
    onRowActivate?.(row.original);
  };

  return (
    <div
      ref={containerRef}
      data-grid-mode={asCards ? "cards" : "table"}
      className={cn(
        "relative w-full min-w-0 max-w-full",
        !asCards && "overflow-x-auto",
        className,
      )}
    >
      {showToolbar && (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          {canSearch && (
            <div className="relative min-w-[10rem] flex-1">
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
                placeholder={
                  asCards
                    ? searchPlaceholder.replace(/\s*\(press \/ to focus\)$/, "")
                    : searchPlaceholder
                }
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
          )}
          {filterOptions.map(({ column, options, hasEmpty }) => {
            const meta = column.columnDef.meta as DataGridColumnMeta | undefined;
            const label = columnLabel(column) || column.id;
            return (
              <select
                key={column.id}
                aria-label={`Filter by ${label.toLowerCase()}`}
                value={columnFilters[column.id] ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  setColumnFilters((current) => ({
                    ...current,
                    [column.id]: value,
                  }));
                  setFocusedRowIndex(-1);
                }}
                className={selectClassName}
              >
                <option value="">
                  {meta?.filterAllLabel ?? `All ${label.toLowerCase()}`}
                </option>
                {options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
                {hasEmpty && (
                  <option value={EMPTY_FILTER_VALUE}>No {label.toLowerCase()}</option>
                )}
              </select>
            );
          })}
          {showSortSelect && (
            <select
              aria-label="Sort by"
              value={sortValue}
              onChange={(event) => setSort(event.target.value)}
              className={selectClassName}
            >
              <option value="">Default order</option>
              {sortableColumns.flatMap((column) => {
                const label = columnLabel(column) || column.id;
                return [
                  <option key={`${column.id}:asc`} value={`${column.id}:asc`}>
                    {label} ↑
                  </option>,
                  <option key={`${column.id}:desc`} value={`${column.id}:desc`}>
                    {label} ↓
                  </option>,
                ];
              })}
            </select>
          )}
          {toolbar}
          {(canSearch || filterOptions.length > 0) && (
            <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
              {narrowed ? `${rowCount} of ${totalCount}` : `${totalCount} rows`}
            </span>
          )}
        </div>
      )}
      {asCards ? (
        <>
          <ul aria-label={ariaLabel} className="text-sm">
            {rows.map((row, rowIndex) => {
              const extra = rowProps?.(row.original, rowIndex) as
                | React.HTMLAttributes<HTMLElement>
                | undefined;
              const group = groupFor(row.original);
              const previousGroup =
                rowIndex > 0 ? groupFor(rows[rowIndex - 1].original) : undefined;
              const showGroupHeader =
                group !== undefined && group !== previousGroup;
              return (
                <React.Fragment key={row.id}>
                  {showGroupHeader && (
                    <li className="border-b bg-muted/50 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {renderGroupHeader ? renderGroupHeader(group) : group}
                    </li>
                  )}
                  <DataGridCard
                    cells={row.getAllCells()}
                    roles={roles}
                    focused={rowIndex === focusedRowIndex}
                    clickable={onRowActivate != null}
                    extra={extra}
                    onClick={(event) => activate(event, extra, row, rowIndex)}
                  />
                </React.Fragment>
              );
            })}
            {emptyText && (
              <li className="px-4 py-6 text-center text-sm text-muted-foreground">
                {emptyText}
              </li>
            )}
          </ul>
          {trailingCard ??
            (trailingRows ? (
              <div className="overflow-x-auto border-t">
                <table className="w-full text-sm">
                  <tbody>{trailingRows}</tbody>
                </table>
              </div>
            ) : null)}
        </>
      ) : (
        <table aria-label={ariaLabel} className="w-full caption-bottom text-sm">
          <thead className="[&_tr]:border-b">
            {headerGroups.map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const meta = header.column.columnDef.meta as
                    | DataGridColumnMeta
                    | undefined;
                  const column = header.column as GridColumn<TData>;
                  const canSort =
                    !header.isPlaceholder &&
                    typeof column.getCanSort === "function" &&
                    column.getCanSort();
                  const sorted = canSort ? column.getIsSorted() : false;
                  return (
                    <th
                      key={header.id}
                      colSpan={header.colSpan}
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : undefined
                      }
                      className={cn(
                        "h-10 whitespace-nowrap px-3 text-left align-middle font-medium text-muted-foreground",
                        meta?.align === "right" && "text-right",
                        meta?.headClassName,
                      )}
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            setFocusedRowIndex(-1);
                            column.getToggleSortingHandler()?.(event);
                          }}
                          className={cn(
                            "-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            meta?.align === "right" && "flex-row-reverse",
                            sorted && "text-foreground",
                          )}
                        >
                          <FlexRender header={header} />
                          {sorted === "asc" ? (
                            <ArrowUp aria-hidden className="size-3.5" />
                          ) : sorted === "desc" ? (
                            <ArrowDown aria-hidden className="size-3.5" />
                          ) : (
                            <ArrowUpDown
                              aria-hidden
                              className="size-3.5 opacity-40"
                            />
                          )}
                        </button>
                      ) : (
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
              const group = groupFor(row.original);
              const previousGroup =
                rowIndex > 0 ? groupFor(rows[rowIndex - 1].original) : undefined;
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
                    onClick={(event) =>
                      activate(
                        event,
                        extra as React.HTMLAttributes<HTMLElement> | undefined,
                        row,
                        rowIndex,
                      )
                    }
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
            {emptyText && (
              <tr>
                <td
                  colSpan={leafColumns.length}
                  className="px-3 py-6 text-center text-sm text-muted-foreground"
                >
                  {emptyText}
                </td>
              </tr>
            )}
            {trailingRows}
          </tbody>
        </table>
      )}
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
