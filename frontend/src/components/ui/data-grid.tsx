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
 * row, shift+arrow extends, Ctrl/Cmd+A selects every visible row and Escape
 * clears. With a selection, a row is opened by double-click or Enter rather
 * than by a single click. Selection is keyed by row id and ranges run over
 * the rows as currently shown (sorted, filtered, searched), so a shift-range
 * follows what the user sees. Narrowing the rows (search or a column filter)
 * clears the selection, so bulk actions never reach rows that are hidden.
 *
 * Columns built with an accessor are sortable (click the header; on phones a
 * "Sort by" select), columns whose meta sets `filter` get a select of their
 * distinct values above the grid, and below the `md` breakpoint every grid
 * renders its rows as cards (see ./data-grid-cards.tsx) — one row per card,
 * one label/value line per column, laid out by `meta.card`. Selectable cards
 * carry a checkbox and a selected tint; a tap selects like a click.
 *
 * Desktop tables fit their container instead of scrolling sideways: headers
 * wrap (two short lines beat a scrollbar), the sort arrow sits after the
 * label and only shows while idle on hover/focus, and cell padding tightens
 * in narrow containers. When the table's measured width still exceeds its
 * container (ResizeObserver), columns marked `meta.priority: "secondary"`
 * move into an expandable detail row, and if that is not enough the grid
 * renders as cards (tiles on a wide screen). `cardMode="phone"` or "never"
 * opts out and keeps a horizontally scrolling table with a thin, themed
 * scrollbar.
 *
 * Keystrokes inside inputs, menus, and dialogs are left alone, so editable
 * cells (e.g. physical-count drafts) and row action menus keep their native
 * behavior. Cells that must swallow a click (menus, inline inputs) can call
 * `event.stopPropagation()` — the grid only listens at the row level.
 *
 * Column defs must not depend on per-keystroke state. TanStack renders a
 * function `cell` as a React component, so a column model rebuilt from draft
 * rows, a selection set or a pending flag gives every cell a new component
 * identity: React remounts the cell, an input inside it loses focus (and a
 * dialog's focus trap then pulls focus back to the dialog). Keep the columns
 * memo's deps to static things (formatters, catalogs, stable callbacks) and
 * pass the mutable state through `useTable({ meta })`; cells read it from
 * their context with `gridMeta<MyMeta>(table)`, which is fresh every render.
 * Never build component functions inside a column builder; a cell that needs
 * hooks is a module-level component fed by props.
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
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  Search,
  X,
} from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { isTypingTarget } from "@/lib/keyboard";
import type { RowSelection } from "@/lib/use-row-selection";

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
  /**
   * Long form of a short header, shown as the header's tooltip. Defaults to
   * `label` when that differs from a string header.
   */
  headerTitle?: string;
  /**
   * "secondary" columns are the first to give way when the table is wider
   * than its container: they leave the table and show in an expandable
   * detail row (and as ordinary fields on cards).
   */
  priority?: "primary" | "secondary";
}

/**
 * The per-render state a grid passed through `useTable({ meta })`, read from
 * a cell's `table`. `useTable` re-applies its options on every render, so this
 * is always the latest value even though the column defs never change (see
 * the header: column defs must not depend on per-keystroke state).
 */
export function gridMeta<TMeta extends object>(table: {
  options: { meta?: object };
}): TMeta {
  return table.options.meta as TMeta;
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
  /**
   * Keep group headers while the table is sorted. For server-sorted
   * (`manualSorting`) tables whose caller passes `getRowGroup` only for the
   * orders the groups follow — e.g. day headers while sorted by date.
   */
  groupWhileSorted?: boolean;
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
   * Multi-select over the rendered rows, keyed by the table's row ids. Give
   * `useRowSelection` every row id (data order is fine); the grid runs
   * ranges and select-all over the rows in their visible order.
   */
  selection?: RowSelection;
  /** Accessible name of the header checkbox. */
  selectAllLabel?: string;
  /** Accessible name of a row's checkbox. */
  getRowLabel?: (row: TData) => string;
  /**
   * "auto" (default) renders cards below the `md` breakpoint and, on wider
   * screens, whenever the table cannot fit its container even with its
   * secondary columns folded away; "never" keeps the table everywhere (wide
   * matrices that read better scrolled), scrolling sideways when it must;
   * "phone" renders cards below `md` only and otherwise keeps every column,
   * scrolling sideways when it must (wide editing grids); "always" is cards
   * everywhere.
   */
  cardMode?: "auto" | "phone" | "never" | "always";
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

/**
 * How a desktop "auto" grid fits its container: every column, primary columns
 * with the secondary ones in a detail row, or cards.
 */
type FitMode = "full" | "compact" | "cards";

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

/** Dotted underline marking a short header whose long form is its tooltip. */
const abbrClassName =
  "underline decoration-dotted decoration-muted-foreground/50 underline-offset-4";

const selectClassName =
  "h-8 min-w-0 max-w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function DataGrid<
  TFeatures extends TableFeatures,
  TData extends RowData,
>({
  table: tableProp,
  getRowGroup,
  renderGroupHeader,
  groupWhileSorted = false,
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
  selection,
  selectAllLabel = "Select all loaded rows",
  getRowLabel,
  cardMode = "auto",
  toolbar,
  emptyMessage,
}: DataGridProps<TFeatures, TData>) {
  // Every grid is built with `dataGridFeatures`; the generic stays loose so
  // callers keep their own inferred table type.
  const table = tableProp as unknown as TanstackTable<GridFeatures, TData>;
  const containerRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const containerId = React.useId();
  const [focusedRowIndex, setFocusedRowIndex] = React.useState(-1);
  const tableRef = React.useRef<HTMLTableElement>(null);
  const belowMd = useBelowMd();
  const [fit, setFit] = React.useState<FitMode>("full");
  const autoFit = cardMode === "auto" && !belowMd;
  const asCards =
    cardMode === "always" ||
    (cardMode === "phone" && belowMd) ||
    (cardMode === "auto" && (belowMd || fit === "cards"));
  const [expandedRows, setExpandedRows] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const canSearch = searchable;
  const [globalFilter, setGlobalFilterText] = React.useState("");
  // A selection belongs to the rows it was made on: narrowing the visible
  // rows drops it rather than leaving hidden rows selected.
  const clearSelectionOnNarrow = () => {
    if (selection && selection.count > 0) selection.clear();
  };
  const setGlobalFilter = (value: string) => {
    setGlobalFilterText(value);
    setFocusedRowIndex(-1);
    if (value.trim() !== globalFilter.trim()) clearSelectionOnNarrow();
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
  const secondaryIds = leafColumns
    .filter(
      (column) =>
        (column.columnDef.meta as DataGridColumnMeta | undefined)?.priority ===
        "secondary",
    )
    .map((column) => column.id);
  const hasSecondary = secondaryIds.length > 0;
  const compact = autoFit && hasSecondary && fit === "compact";
  const hiddenIds = compact ? new Set(secondaryIds) : null;
  const isShown = (columnId: string) => !hiddenIds?.has(columnId);

  // Fit the table to its container. Each overflow seen records the width the
  // table needed in that mode, so the grid steps back up (cards -> compact ->
  // full) only once the container is wide enough again — no oscillation, and
  // layout effects settle before paint, so no flash of an overflowing table.
  const fitWidths = React.useRef({ full: 0, compact: 0 });
  const fitRef = React.useRef(fit);
  useIsomorphicLayoutEffect(() => {
    fitRef.current = fit;
    if (!autoFit) return;
    const container = containerRef.current;
    if (!container) return;
    const evaluate = () => {
      const available = container.clientWidth;
      if (available === 0) return; // hidden (inactive tab, collapsed panel)
      const current = fitRef.current;
      const widths = fitWidths.current;
      const tableEl = tableRef.current;
      let next = current;
      if (current !== "cards" && tableEl && tableEl.offsetWidth > available + 1) {
        if (current === "full") {
          widths.full = tableEl.offsetWidth;
          next = hasSecondary ? "compact" : "cards";
        } else {
          widths.compact = tableEl.offsetWidth;
          next = "cards";
        }
      } else if (current === "cards") {
        const needed = hasSecondary ? widths.compact : widths.full;
        if (available >= needed) next = hasSecondary ? "compact" : "full";
      } else if (current === "compact" && available >= widths.full) {
        next = "full";
      }
      if (next !== current) {
        fitRef.current = next;
        setFit(next);
      }
    };
    evaluate();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(evaluate);
    observer.observe(container);
    if (tableRef.current) observer.observe(tableRef.current);
    return () => observer.disconnect();
  }, [autoFit, fit, hasSecondary]);

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
  // Row ids in visible order (sorted, filtered, searched): selection ranges
  // and select-all run over these, never over the data's own order.
  const visibleIds = rows.map((row) => row.id);
  const visibleSelectedCount = selection
    ? visibleIds.reduce((n, id) => n + (selection.isSelected(id) ? 1 : 0), 0)
    : 0;
  const allVisibleSelected =
    rowCount > 0 && visibleSelectedCount === rowCount;
  const selectAllChecked: boolean | "indeterminate" = allVisibleSelected
    ? true
    : (selection?.count ?? 0) > 0
      ? "indeterminate"
      : false;
  const toggleSelectAll = () => {
    if (!selection) return;
    if (allVisibleSelected) selection.clear();
    else selection.selectAll(visibleIds);
  };

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
    visibleIds,
    onRowActivate,
    onRowDelete,
    selection,
  });
  React.useEffect(() => {
    stateRef.current = {
      rowCount,
      focusedRowIndex,
      rows,
      visibleIds,
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
        state.selection.selectAll(state.visibleIds);
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
              state.visibleIds,
            );
          }
        }
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
          state.selection.toggle(row.id, event.shiftKey, state.visibleIds);
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

  // Cards on a desktop-width container (the table did not fit) tile across
  // the width instead of stretching one card per line.
  const tiles = asCards && autoFit;
  const showSortSelect = asCards && sortableColumns.length > 0;
  // Cards have no header row, so their select-all checkbox lives here.
  const showCardSelectAll = asCards && selection != null;
  const showToolbar =
    canSearch ||
    filterOptions.length > 0 ||
    showSortSelect ||
    showCardSelectAll ||
    toolbar != null;
  const sortValue = sorting[0]
    ? `${sorting[0].id}:${sorting[0].desc ? "desc" : "asc"}`
    : "";

  const groupFor = (row: TData) =>
    isSorted && !groupWhileSorted ? undefined : getRowGroup?.(row);

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

  // Row (table) and card (phone) share these handlers, so a click, tap,
  // shift-click or double-click means the same thing in both layouts.
  type RowExtra = React.HTMLAttributes<HTMLElement> | undefined;

  const handleRowClick = (
    event: React.MouseEvent<HTMLElement>,
    extra: RowExtra,
    row: Row<GridFeatures, TData>,
    rowIndex: number,
  ) => {
    extra?.onClick?.(event);
    if (event.defaultPrevented) return;
    setFocusedRowIndex(rowIndex);
    if (selection) {
      selection.click(
        row.id,
        { shift: event.shiftKey, toggle: event.ctrlKey || event.metaKey },
        visibleIds,
      );
      return;
    }
    onRowActivate?.(row.original);
  };

  const handleRowMouseDown = (
    event: React.MouseEvent<HTMLElement>,
    extra: RowExtra,
  ) => {
    extra?.onMouseDown?.(event);
    // Shift-click selects a range; keep the browser from also highlighting
    // the text in between.
    if (selection && event.shiftKey) event.preventDefault();
  };

  const handleRowDoubleClick = (
    event: React.MouseEvent<HTMLElement>,
    extra: RowExtra,
    row: Row<GridFeatures, TData>,
  ) => {
    extra?.onDoubleClick?.(event);
    if (event.defaultPrevented || !selection || !onRowActivate) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey) return;
    onRowActivate(row.original);
  };

  const rowCheckbox = (
    row: Row<GridFeatures, TData>,
    rowIndex: number,
    rowSelected: boolean,
  ) =>
    selection ? (
      <Checkbox
        checked={rowSelected}
        tabIndex={-1}
        aria-label={getRowLabel ? getRowLabel(row.original) : "Select row"}
        onClick={(event) => {
          // The checkbox toggles (shift adds the range from the anchor); it
          // never collapses the selection the way a plain row click does.
          event.preventDefault();
          event.stopPropagation();
          setFocusedRowIndex(rowIndex);
          selection.toggle(row.id, event.shiftKey, visibleIds);
        }}
        onMouseDown={(event) => {
          if (event.shiftKey) event.preventDefault();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      />
    ) : null;

  return (
    <div
      ref={containerRef}
      data-grid-mode={asCards ? "cards" : "table"}
      data-grid-fit={autoFit ? fit : undefined}
      className={cn(
        "@container relative w-full min-w-0 max-w-full",
        // A fitted table never overflows; clipping only trims a last column's
        // hover-only sort arrow. Tables that opt out scroll, thinly.
        !asCards &&
          (autoFit
            ? "overflow-x-clip"
            : "overflow-x-auto [scrollbar-color:var(--color-border)_transparent] [scrollbar-width:thin]"),
        className,
      )}
    >
      {showToolbar && (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          {showCardSelectAll && (
            <label className="inline-flex min-h-8 items-center gap-2 pr-1 text-sm text-muted-foreground">
              <Checkbox
                checked={selectAllChecked}
                disabled={rowCount === 0}
                aria-label={selectAllLabel}
                onClick={(event) => {
                  event.preventDefault();
                  toggleSelectAll();
                }}
              />
              <span aria-hidden>All</span>
            </label>
          )}
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
                  clearSelectionOnNarrow();
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
              {narrowed
                ? `${rowCount} of ${totalCount}`
                : `${totalCount} ${totalCount === 1 ? "row" : "rows"}`}
            </span>
          )}
        </div>
      )}
      {asCards ? (
        <>
          <ul
            aria-label={ariaLabel}
            className={cn(
              "text-sm",
              tiles &&
                "grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3 p-3",
            )}
          >
            {rows.map((row, rowIndex) => {
              const extra = rowProps?.(row.original, rowIndex) as
                | React.HTMLAttributes<HTMLElement>
                | undefined;
              const group = groupFor(row.original);
              const previousGroup =
                rowIndex > 0 ? groupFor(rows[rowIndex - 1].original) : undefined;
              const showGroupHeader =
                group !== undefined && group !== previousGroup;
              const rowSelected = selection?.isSelected(row.id) ?? false;
              return (
                <React.Fragment key={row.id}>
                  {showGroupHeader && (
                    <li
                      className={cn(
                        "border-b bg-muted/50 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground",
                        tiles && "col-span-full rounded-md border-b-0",
                      )}
                    >
                      {renderGroupHeader ? renderGroupHeader(group) : group}
                    </li>
                  )}
                  <DataGridCard
                    cells={row.getAllCells()}
                    roles={roles}
                    tile={tiles}
                    focused={rowIndex === focusedRowIndex}
                    clickable={onRowActivate != null || selection != null}
                    selected={selection ? rowSelected : undefined}
                    leading={rowCheckbox(row, rowIndex, rowSelected)}
                    extra={extra}
                    onClick={(event) =>
                      handleRowClick(event, extra, row, rowIndex)
                    }
                    onMouseDown={(event) => handleRowMouseDown(event, extra)}
                    onDoubleClick={(event) =>
                      handleRowDoubleClick(event, extra, row)
                    }
                  />
                </React.Fragment>
              );
            })}
            {emptyText && (
              <li
                className={cn(
                  "px-4 py-6 text-center text-sm text-muted-foreground",
                  tiles && "col-span-full",
                )}
              >
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
        <table
          ref={tableRef}
          aria-label={ariaLabel}
          className="w-full caption-bottom text-sm [--cell-px:0.5rem] @6xl:[--cell-px:0.75rem]"
        >
          <thead className="[&_tr]:border-b">
            {headerGroups.map((headerGroup) => (
              <tr key={headerGroup.id}>
                {selection && (
                  <th className="h-10 w-10 px-3 align-bottom pb-2.5">
                    <Checkbox
                      checked={selectAllChecked}
                      disabled={rowCount === 0}
                      aria-label={selectAllLabel}
                      onClick={(event) => {
                        event.preventDefault();
                        toggleSelectAll();
                      }}
                    />
                  </th>
                )}
                {headerGroup.headers.filter((header) => isShown(header.column.id)).map((header) => {
                  const meta = header.column.columnDef.meta as
                    | DataGridColumnMeta
                    | undefined;
                  const column = header.column as GridColumn<TData>;
                  const canSort =
                    !header.isPlaceholder &&
                    typeof column.getCanSort === "function" &&
                    column.getCanSort();
                  const sorted = canSort ? column.getIsSorted() : false;
                  const right = meta?.align === "right";
                  const headerText = column.columnDef.header;
                  const longForm =
                    meta?.headerTitle ??
                    (meta?.label &&
                    typeof headerText === "string" &&
                    meta.label !== headerText
                      ? meta.label
                      : undefined);
                  return (
                    <th
                      key={header.id}
                      colSpan={header.colSpan}
                      title={longForm}
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : undefined
                      }
                      className={cn(
                        // Labels wrap (balanced, at most a couple of short
                        // lines) rather than widening the table; bottom
                        // alignment keeps one- and two-line labels on the
                        // same baseline over their values.
                        "h-10 px-(--cell-px) pb-2 pt-2 text-left align-bottom font-medium leading-tight text-muted-foreground [text-wrap:balance]",
                        right && "text-right",
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
                            "group/sort relative -mx-1 inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            right && "text-right",
                            sorted && "text-foreground",
                          )}
                        >
                          <span className={cn(longForm && abbrClassName)}>
                            <FlexRender header={header} />
                          </span>
                          {sorted === "asc" ? (
                            <ArrowUp aria-hidden className="size-3 shrink-0" />
                          ) : sorted === "desc" ? (
                            <ArrowDown aria-hidden className="size-3 shrink-0" />
                          ) : (
                            // Idle: takes no width, shown on hover/focus in
                            // the free space beside the label (left of a
                            // right-aligned label, right of a left one).
                            <ArrowUpDown
                              aria-hidden
                              className={cn(
                                "pointer-events-none absolute top-1/2 hidden size-3 -translate-y-1/2 opacity-50 group-hover/sort:block group-focus-visible/sort:block",
                                right ? "right-full" : "left-full",
                              )}
                            />
                          )}
                        </button>
                      ) : longForm ? (
                        <span className={cn("cursor-help", abbrClassName)}>
                          <FlexRender header={header} />
                        </span>
                      ) : (
                        <FlexRender header={header} />
                      )}
                    </th>
                  );
                })}
                {compact && (
                  <th className="w-8 px-1">
                    <span className="sr-only">More details</span>
                  </th>
                )}
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
              const rowSelected = selection?.isSelected(row.id) ?? false;
              const handlerExtra = extra as RowExtra;
              const allCells = row.getAllCells();
              const cells = compact
                ? allCells.filter((cell) => isShown(cell.column.id))
                : allCells;
              const detailCells = compact
                ? allCells.filter((cell) => !isShown(cell.column.id))
                : [];
              const expanded = compact && expandedRows.has(row.id);
              const spanAll =
                cells.length + (selection ? 1 : 0) + (compact ? 1 : 0);
              const detailId = `${containerId}-detail-${row.id}`;
              return (
                <React.Fragment key={row.id}>
                  {showGroupHeader && (
                    <tr className="border-b bg-muted/50">
                      <td
                        colSpan={spanAll}
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
                    onMouseDown={(event) =>
                      handleRowMouseDown(event, handlerExtra)
                    }
                    onClick={(event) =>
                      handleRowClick(event, handlerExtra, row, rowIndex)
                    }
                    onDoubleClick={(event) =>
                      handleRowDoubleClick(event, handlerExtra, row)
                    }
                  >
                    {selection && (
                      <td className="w-10 px-3 align-middle">
                        {rowCheckbox(row, rowIndex, rowSelected)}
                      </td>
                    )}
                    {cells.map((cell) => {
                      const meta = cell.column.columnDef.meta as
                        | DataGridColumnMeta
                        | undefined;
                      return (
                        <td
                          key={cell.id}
                          className={cn(
                            "whitespace-nowrap px-(--cell-px) py-3 align-middle",
                            meta?.align === "right" && "text-right",
                            meta?.cellClassName,
                          )}
                        >
                          <FlexRender cell={cell} />
                        </td>
                      );
                    })}
                    {compact && (
                      <td className="w-8 px-1 align-middle">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-controls={expanded ? detailId : undefined}
                          aria-label={
                            expanded ? "Hide more details" : "Show more details"
                          }
                          title={detailCells
                            .map((cell) => columnLabel(cell.column))
                            .filter(Boolean)
                            .join(", ")}
                          onClick={(event) => {
                            event.stopPropagation();
                            setExpandedRows((current) => {
                              const next = new Set(current);
                              if (next.has(row.id)) next.delete(row.id);
                              else next.add(row.id);
                              return next;
                            });
                          }}
                          onDoubleClick={(event) => event.stopPropagation()}
                          className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <ChevronDown
                            aria-hidden
                            className={cn(
                              "size-4 transition-transform",
                              expanded && "rotate-180",
                            )}
                          />
                        </button>
                      </td>
                    )}
                  </tr>
                  {expanded && (
                    <tr id={detailId} data-grid-detail="" className="border-b bg-muted/20">
                      <td colSpan={spanAll} className="px-3 py-2">
                        <dl className="flex flex-wrap gap-x-6 gap-y-1">
                          {detailCells.map((cell) => {
                            const meta = cell.column.columnDef.meta as
                              | DataGridColumnMeta
                              | undefined;
                            return (
                              <div
                                key={cell.id}
                                className="flex items-baseline gap-2"
                              >
                                <dt className="text-xs uppercase tracking-wider text-muted-foreground">
                                  {columnLabel(cell.column) || cell.column.id}
                                </dt>
                                <dd
                                  className={cn(
                                    meta?.align === "right" && "tabular-nums",
                                  )}
                                >
                                  <FlexRender cell={cell} />
                                </dd>
                              </div>
                            );
                          })}
                        </dl>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {emptyText && (
              <tr>
                <td
                  colSpan={
                    leafColumns.filter((column) => isShown(column.id)).length +
                    (selection ? 1 : 0) +
                    (compact ? 1 : 0)
                  }
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
