"use client";

/**
 * Sales › Expenses › Categorize: every entry the Folio history import brought
 * in (migration 00064) as a selectable DataGrid, so a long history can be
 * categorized in bulk instead of one card at a time.
 *
 * - One row per imported entry: date, direction (expense, refund, income),
 *   the Folio description, the signed amount, an inline category picker, the
 *   sale an income entry pays for (or "Link to sale"), its status and, when
 *   more than one Folio book is involved, the book.
 * - Status, direction and category filters and the description search live
 *   in the URL with the sort, so a reload or a shared link keeps the view.
 *   The default status is "Needs attention": uncategorized entries and
 *   anything changed or deleted in Folio.
 * - Desktop selection (DataGrid `selection`): click, shift-click range (in
 *   the on-screen order), ctrl/cmd toggle, Ctrl/Cmd+A, Escape. The bulk bar
 *   sets one category on every selected entry of one kind — expense
 *   categories for expenses and refunds, income categories for income — and
 *   settles selected conflicts (keep Atlas / accept Folio). Each bulk change
 *   is one all-or-nothing request.
 * - Phones get cards, with the category picker, sale link and conflict
 *   actions on each card.
 *
 * Nothing here writes to Folio: categorizing changes Atlas only.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createColumnHelper, useTable } from "@tanstack/react-table";
import type { SortingState, Updater } from "@tanstack/react-table";
import { ArrowLeft, Link2, Search, X } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataGrid,
  DataGridCellAction,
  gridMeta,
  dataGridFeatures,
  type DataGridColumnMeta,
} from "@/components/ui/data-grid";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatMoney } from "@/features/honey/format";
import { errorMessage } from "@/features/settings/gnucash-format";
import {
  FINANCE_CATEGORIES_HREF,
  useFinanceCategories,
} from "@/features/settings/finance-categories-api";
import { useRowSelection } from "@/lib/use-row-selection";
import { cn } from "@/lib/utils";

import {
  FOLIO_IMPORTS_MAX_LIMIT,
  folioBulkRejections,
  formatFolioAmount,
  useAcceptFolioImport,
  useBulkAcceptFolioImports,
  useBulkCategorizeFolioImports,
  useBulkKeepFolioImports,
  useCategorizeFolioImport,
  useFolioImports,
  useKeepFolioImport,
  type FolioImportItem,
} from "./folio-imports-api";
import { FolioSaleLinker } from "./folio-sale-linker";

// --- Row facts -------------------------------------------------------------

type Direction = "expense" | "refund" | "income";
type Status = "uncategorized" | "categorized" | "changed" | "deleted";

const DIRECTION_LABEL: Record<Direction, string> = {
  expense: "Expense",
  refund: "Refund",
  income: "Income",
};

const DIRECTION_CLASS: Record<Direction, string> = {
  expense: "border-transparent bg-slate-500/15 text-slate-700 dark:text-slate-300",
  refund: "border-transparent bg-blue-500/15 text-blue-700 dark:text-blue-300",
  income: "border-transparent bg-green-600/15 text-green-700 dark:text-green-400",
};

const STATUS_LABEL: Record<Status, string> = {
  uncategorized: "Uncategorized",
  categorized: "Categorized",
  changed: "Changed in Folio",
  deleted: "Deleted in Folio",
};

function directionOf(item: FolioImportItem): Direction {
  if (item.direction === "income") return "income";
  return item.amount < 0 ? "refund" : "expense";
}

function statusOf(item: FolioImportItem): Status {
  if (item.state === "remote_deleted") return "deleted";
  if (item.state) return "changed";
  return item.category === "uncategorized" ? "uncategorized" : "categorized";
}

/** Still in Atlas and not waiting on a Folio deletion: a category can be set. */
function categorizable(item: FolioImportItem): boolean {
  return !item.deleted && item.state !== "remote_deleted";
}

/** Positive, live income can be a sale's deposit. */
function linkable(item: FolioImportItem): boolean {
  return item.direction === "income" && item.amount > 0 && categorizable(item);
}

/** unlinkedIncomeSQL on the client: a deposit that may be an unlinked sale. */
const SALES_LIKE = new Set(["uncategorized", "honey_sales", "colony_sales", "product_sales"]);
function unlinked(item: FolioImportItem): boolean {
  return (
    item.direction === "income" &&
    !item.deleted &&
    item.saleId == null &&
    item.amount > 0 &&
    SALES_LIKE.has(item.category)
  );
}

// --- URL state -------------------------------------------------------------

const STATUS_FILTERS = [
  { value: "attention", label: "Needs attention" },
  { value: "uncategorized", label: "Uncategorized" },
  { value: "changed", label: "Changed in Folio" },
  { value: "deleted", label: "Deleted in Folio" },
  { value: "categorized", label: "Categorized" },
  { value: "unlinked", label: "Not linked to a sale" },
  { value: "all", label: "All statuses" },
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];
const DEFAULT_STATUS: StatusFilter = "attention";

function matchesStatus(item: FolioImportItem, filter: StatusFilter): boolean {
  const status = statusOf(item);
  switch (filter) {
    case "attention":
      return status !== "categorized";
    case "unlinked":
      return unlinked(item);
    case "all":
      return true;
    default:
      return status === filter;
  }
}

const SORT_IDS = ["date", "direction", "description", "amount", "category", "sale", "status", "book"];
const DEFAULT_SORT = "date";
const DEFAULT_DIR = "desc";

interface CategorizeParams {
  status: StatusFilter;
  direction: Direction | "";
  category: string;
  q: string;
  sort: string;
  dir: "asc" | "desc";
}

function parseParams(searchParams: URLSearchParams): CategorizeParams {
  const status = searchParams.get("status");
  const direction = searchParams.get("direction");
  const sort = searchParams.get("sort");
  const dir = searchParams.get("dir");
  const parsedSort = sort && SORT_IDS.includes(sort) ? sort : DEFAULT_SORT;
  return {
    status: STATUS_FILTERS.some((option) => option.value === status)
      ? (status as StatusFilter)
      : DEFAULT_STATUS,
    direction:
      direction === "expense" || direction === "refund" || direction === "income"
        ? direction
        : "",
    category: searchParams.get("category") ?? "",
    q: searchParams.get("q") ?? "",
    sort: parsedSort,
    dir:
      dir === "asc" || dir === "desc"
        ? dir
        : parsedSort === DEFAULT_SORT
          ? DEFAULT_DIR
          : "asc",
  };
}

/** Two query strings with the same parameters, in any order. */
function sameQuery(a: string, b: string): boolean {
  const normalize = (query: string) =>
    [...new URLSearchParams(query).entries()]
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join("&");
  return normalize(a) === normalize(b);
}

/**
 * The page's filters as URL state. Every update merges onto the newest query
 * — including one written a moment ago whose navigation has not landed yet —
 * so a search typed right after picking a filter keeps the filter (the
 * movement ledger's fix, activity-tab.tsx).
 */
function useCategorizeParams(onChange: () => void) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const renderedQuery = searchParams.toString();
  const params = React.useMemo(
    () => parseParams(new URLSearchParams(renderedQuery)),
    [renderedQuery],
  );
  const renderedQueryRef = React.useRef(renderedQuery);
  const pendingQueryRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    renderedQueryRef.current = renderedQuery;
    if (
      pendingQueryRef.current !== null &&
      sameQuery(pendingQueryRef.current, renderedQuery)
    ) {
      pendingQueryRef.current = null;
    }
  }, [renderedQuery]);

  const setParams = React.useCallback(
    (next: Partial<CategorizeParams>) => {
      const current = pendingQueryRef.current ?? renderedQueryRef.current;
      const query = new URLSearchParams(current);
      const put = (key: string, value: string | undefined, fallback = "") => {
        if (value === undefined) return;
        if (value && value !== fallback) query.set(key, value);
        else query.delete(key);
      };
      put("status", next.status, DEFAULT_STATUS);
      put("direction", next.direction);
      put("category", next.category);
      put("q", next.q?.trim());
      if (next.sort !== undefined || next.dir !== undefined) {
        const sort = next.sort ?? query.get("sort") ?? DEFAULT_SORT;
        const dir = next.dir ?? query.get("dir") ?? (sort === DEFAULT_SORT ? DEFAULT_DIR : "asc");
        if (sort === DEFAULT_SORT && dir === DEFAULT_DIR) {
          query.delete("sort");
          query.delete("dir");
        } else {
          query.set("sort", sort);
          query.set("dir", dir);
        }
      }
      const search = query.toString();
      if (sameQuery(search, current)) return;
      pendingQueryRef.current = search;
      onChange();
      router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
    },
    [pathname, router, onChange],
  );
  return [params, setParams] as const;
}

// --- Page ------------------------------------------------------------------

const columnHelper = createColumnHelper<typeof dataGridFeatures, FolioImportItem>();

/** What the editable cells read from `table.options.meta`. */
interface CategorizeMeta {
  busy: boolean;
  expenseCategories: string[];
  incomeCategories: string[];
  labelFor: (direction: FolioImportItem["direction"], key: string) => string;
  resolveRow: (item: FolioImportItem, accept: boolean) => void;
  setRowCategory: (item: FolioImportItem, category: string) => void;
  setLinking: (item: FolioImportItem | null) => void;
}

const selectClassName =
  "h-8 min-w-0 max-w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function entries(count: number): string {
  return `${count} entr${count === 1 ? "y" : "ies"}`;
}

/** A failed bulk request: the server's message, and why the first rows were refused. */
function bulkError(error: unknown, fallback: string, byId: Map<string, FolioImportItem>) {
  const rejected = folioBulkRejections(error);
  const description = rejected
    .slice(0, 3)
    .map((entry) => `${byId.get(entry.id)?.description ?? "Entry"}: ${entry.reason}`)
    .join(" · ");
  toast.error(errorMessage(error, fallback), description ? { description } : undefined);
}

export function FolioCategorize() {
  const imports = useFolioImports("all", FOLIO_IMPORTS_MAX_LIMIT);
  const categorizeOne = useCategorizeFolioImport();
  const acceptOne = useAcceptFolioImport();
  const keepOne = useKeepFolioImport();
  const bulkCategorize = useBulkCategorizeFolioImports();
  const bulkAccept = useBulkAcceptFolioImports();
  const bulkKeep = useBulkKeepFolioImports();
  const [linking, setLinking] = React.useState<FolioImportItem | null>(null);
  const [confirmAccept, setConfirmAccept] = React.useState<FolioImportItem[] | null>(null);
  const [bulkCategory, setBulkCategory] = React.useState("");

  const clearSelectionRef = React.useRef<() => void>(() => {});
  const onParamsChange = React.useCallback(() => clearSelectionRef.current(), []);
  const [params, setParams] = useCategorizeParams(onParamsChange);
  const [searchText, setSearchText] = React.useState(params.q);
  const searchRef = React.useRef<HTMLInputElement>(null);

  // Search is debounced into the URL.
  React.useEffect(() => {
    if (searchText.trim() === params.q.trim()) return;
    const timer = window.setTimeout(() => setParams({ q: searchText }), 250);
    return () => window.clearTimeout(timer);
  }, [searchText, params.q, setParams]);

  const allItems = React.useMemo(() => imports.data?.items ?? [], [imports.data]);
  const byId = React.useMemo(
    () => new Map(allItems.map((item) => [item.id, item])),
    [allItems],
  );
  // Labels come from the operator's category lists (Operation setup); the
  // keys a picker offers come with the entries (active categories, in their
  // display order), else from those lists.
  const expenseList = useFinanceCategories("expense");
  const incomeList = useFinanceCategories("income");
  const labelFor = React.useCallback(
    (direction: FolioImportItem["direction"], key: string) =>
      (direction === "income" ? incomeList : expenseList).label(key),
    [expenseList, incomeList],
  );
  /** A label for a key of either kind (the category filter spans both). */
  const anyLabel = React.useCallback(
    (key: string) => expenseList.byKey.get(key)?.label ?? incomeList.label(key),
    [expenseList, incomeList],
  );
  const expenseCategories = React.useMemo(
    () =>
      (imports.data?.expenseCategories ?? expenseList.active.map((row) => row.key)).filter(
        (value) => value !== "uncategorized",
      ),
    [imports.data, expenseList],
  );
  const incomeCategories = React.useMemo(
    () =>
      (imports.data?.otherIncomeCategories ?? incomeList.active.map((row) => row.key)).filter(
        (value) => value !== "uncategorized",
      ),
    [imports.data, incomeList],
  );
  const multipleBooks = React.useMemo(
    () => new Set(allItems.map((item) => item.bookId)).size > 1,
    [allItems],
  );

  const terms = params.q.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = React.useMemo(
    () =>
      allItems.filter((item) => {
        if (!matchesStatus(item, params.status)) return false;
        if (params.direction && directionOf(item) !== params.direction) return false;
        if (params.category && item.category !== params.category) return false;
        if (terms.length > 0) {
          const haystack = `${item.description} ${item.notes ?? ""}`.toLowerCase();
          if (!terms.every((term) => haystack.includes(term))) return false;
        }
        return true;
      }),
    // `terms` is derived from params.q.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allItems, params.status, params.direction, params.category, params.q],
  );
  const categoryOptions = React.useMemo(
    () =>
      [...new Set(allItems.map((item) => item.category))].sort((a, b) =>
        anyLabel(a).localeCompare(anyLabel(b)),
      ),
    [allItems, anyLabel],
  );

  const ids = React.useMemo(() => rows.map((item) => item.id), [rows]);
  const selection = useRowSelection(ids);
  React.useEffect(() => {
    clearSelectionRef.current = selection.clear;
  }, [selection.clear]);

  const busy =
    categorizeOne.isPending ||
    acceptOne.isPending ||
    keepOne.isPending ||
    bulkCategorize.isPending ||
    bulkAccept.isPending ||
    bulkKeep.isPending;

  const setRowCategory = React.useCallback(
    (item: FolioImportItem, category: string) =>
      categorizeOne.mutate(
        { id: item.id, category },
        {
          onSuccess: () =>
            toast.success(`Categorized as ${labelFor(item.direction, category)}`),
          onError: (error) =>
            toast.error(errorMessage(error, "Could not save the category")),
        },
      ),
    [categorizeOne, labelFor],
  );
  const resolveRow = React.useCallback(
    (item: FolioImportItem, accept: boolean) => {
      const mutation = accept ? acceptOne : keepOne;
      mutation.mutate(item.id, {
        onSuccess: () =>
          toast.success(accept ? "Applied the Folio version" : "Kept the Atlas entry"),
        onError: (error) =>
          toast.error(
            errorMessage(error, accept ? "Could not apply the Folio version" : "Could not dismiss"),
          ),
      });
    },
    [acceptOne, keepOne],
  );

  // The table's sorting is the URL's; rows are sorted on the client.
  const sorting = React.useMemo<SortingState>(
    () => [{ id: params.sort, desc: params.dir === "desc" }],
    [params.sort, params.dir],
  );
  const onSortingChange = React.useCallback(
    (updater: Updater<SortingState>) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      const first = next[0];
      if (!first || !SORT_IDS.includes(first.id)) {
        setParams({ sort: DEFAULT_SORT, dir: DEFAULT_DIR });
        return;
      }
      setParams({ sort: first.id, dir: first.desc ? "desc" : "asc" });
    },
    [sorting, setParams],
  );

  const columns = React.useMemo(() => {
    const base = columnHelper.columns([
      columnHelper.accessor((item) => item.date, {
        id: "date",
        header: "Date",
        sortDescFirst: true,
        meta: {
          card: "subtitle",
          headClassName: "w-28",
          cellClassName: "tabular-nums text-muted-foreground",
        } satisfies DataGridColumnMeta,
        cell: ({ row: { original: item } }) => formatDate(item.date),
      }),
      columnHelper.accessor((item) => DIRECTION_LABEL[directionOf(item)], {
        id: "direction",
        header: "Direction",
        meta: { card: "badge", headClassName: "w-28" } satisfies DataGridColumnMeta,
        cell: ({ row: { original: item } }) => {
          const direction = directionOf(item);
          return (
            <Badge
              data-direction={direction}
              variant="outline"
              className={DIRECTION_CLASS[direction]}
            >
              {DIRECTION_LABEL[direction]}
            </Badge>
          );
        },
      }),
      columnHelper.accessor((item) => item.description, {
        id: "description",
        header: "Description",
        meta: {
          card: "title",
          cellClassName: "min-w-[14rem] max-w-[28rem] whitespace-normal",
        } satisfies DataGridColumnMeta,
        cell: ({ row: { original: item } }) => (
          <span className="grid min-w-0 gap-0.5">
            <span className={cn("font-medium", item.deleted && "line-through")}>
              {item.description}
            </span>
            {item.notes ? (
              <span className="text-xs text-muted-foreground">{item.notes}</span>
            ) : null}
          </span>
        ),
      }),
      columnHelper.accessor((item) => item.amount, {
        id: "amount",
        header: "Amount",
        meta: { align: "right", cellClassName: "tabular-nums" } satisfies DataGridColumnMeta,
        cell: ({ row: { original: item } }) => (
          <span
            className={cn(
              "font-medium",
              item.direction === "income" && item.amount > 0 && "text-success",
              item.amount < 0 && "text-blue-700 dark:text-blue-300",
            )}
          >
            {formatFolioAmount(item.direction, item.amount, formatMoney)}
          </span>
        ),
      }),
      columnHelper.accessor((item) => labelFor(item.direction, item.category), {
        id: "category",
        header: "Category",
        meta: { cellClassName: "min-w-[12rem]" } satisfies DataGridColumnMeta,
        cell: ({ row: { original: item }, table }) => {
          const { busy, expenseCategories, incomeCategories, labelFor, setRowCategory } =
            gridMeta<CategorizeMeta>(table);
          const offered =
            item.direction === "expense" ? expenseCategories : incomeCategories;
          // An entry filed under a category since archived still shows it.
          const choices =
            item.category !== "uncategorized" && !offered.includes(item.category)
              ? [item.category, ...offered]
              : offered;
          return (
            <DataGridCellAction>
              <Select
                value={item.category === "uncategorized" ? "" : item.category}
                onValueChange={(value) => setRowCategory(item, value)}
                disabled={busy || !categorizable(item)}
              >
                <SelectTrigger
                  className="h-8 w-48"
                  aria-label={`Category for ${item.description}`}
                  title={
                    categorizable(item)
                      ? undefined
                      : "Deleted in Folio: accept or keep it first"
                  }
                >
                  <SelectValue placeholder="Choose a category" />
                </SelectTrigger>
                <SelectContent>
                  {choices.map((value) => (
                    <SelectItem key={value} value={value}>
                      {labelFor(item.direction, value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DataGridCellAction>
          );
        },
      }),
      columnHelper.accessor((item) => item.saleSummary ?? "", {
        id: "sale",
        header: "Sale",
        meta: { cellClassName: "whitespace-normal" } satisfies DataGridColumnMeta,
        cell: ({ row: { original: item }, table }) => {
          const { busy, setLinking } = gridMeta<CategorizeMeta>(table);
          if (linkable(item)) {
            return (
              <DataGridCellAction>
                <Button
                  type="button"
                  size="sm"
                  variant={item.saleId ? "ghost" : "outline"}
                  disabled={busy}
                  aria-label={
                    item.saleSummary
                      ? `Change the sale for ${item.description}`
                      : `Link ${item.description} to a sale`
                  }
                  onClick={() => setLinking(item)}
                >
                  <Link2 />
                  {item.saleSummary ? `Sale ${item.saleSummary}` : "Link to sale"}
                </Button>
              </DataGridCellAction>
            );
          }
          const reason =
            item.direction === "expense"
              ? "Only income can be linked to a sale"
              : item.amount < 0
                ? "Money paid back can't be a sale's deposit"
                : "Settle the Folio change first";
          return (
            <span title={reason} className="inline-flex">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled
                aria-label={`Link to sale — ${reason}`}
              >
                <Link2 />
                Link to sale
              </Button>
              <span className="sr-only">{reason}</span>
            </span>
          );
        },
      }),
      columnHelper.accessor((item) => STATUS_LABEL[statusOf(item)], {
        id: "status",
        header: "Status",
        meta: { cellClassName: "min-w-[15rem] whitespace-normal" } satisfies DataGridColumnMeta,
        cell: ({ row: { original: item }, table }) => {
          const { busy, resolveRow } = gridMeta<CategorizeMeta>(table);
          const status = statusOf(item);
          return (
            <span className="grid justify-items-start gap-1">
              <Badge
                data-status={status}
                title={item.message ?? undefined}
                variant={
                  status === "uncategorized"
                    ? "default"
                    : status === "categorized"
                      ? "secondary"
                      : "destructive"
                }
              >
                {STATUS_LABEL[status]}
              </Badge>
              {item.state ? (
                <>
                  {item.pending ? (
                    <span className="text-xs text-muted-foreground">
                      Folio now: {item.pending.description} ·{" "}
                      {formatFolioAmount(
                        item.pending.direction,
                        item.pending.amountCents / 100,
                        formatMoney,
                      )}
                    </span>
                  ) : item.message && item.message !== STATUS_LABEL[status] ? (
                    <span className="text-xs text-muted-foreground">{item.message}</span>
                  ) : null}
                  <DataGridCellAction className="flex flex-wrap gap-1">
                    {item.state !== "unrepresentable" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => resolveRow(item, true)}
                      >
                        {item.state === "remote_deleted" ? "Remove from Atlas" : "Accept Folio"}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => resolveRow(item, false)}
                    >
                      Keep Atlas
                    </Button>
                  </DataGridCellAction>
                </>
              ) : null}
            </span>
          );
        },
      }),
    ]);
    if (!multipleBooks) return base;
    const book = columnHelper.columns([
      columnHelper.accessor((item) => item.bookLabel, {
        id: "book",
        header: "Book",
        meta: { cellClassName: "text-muted-foreground" } satisfies DataGridColumnMeta,
        cell: ({ row: { original: item } }) =>
          `${item.bookLabel}${item.bookRetired ? " (retired)" : ""}`,
      }),
    ]);
    return [...base, ...book];
    // `labelFor` is read by the category accessor, so it stays a dep; the
    // busy flag, the categories and the row callbacks reach the cells through
    // `meta` so a mutation never rebuilds a column and remounts the focused
    // select or button (see data-grid.tsx).
  }, [labelFor, multipleBooks]);

  const categorizeMeta: CategorizeMeta = {
    busy,
    expenseCategories,
    incomeCategories,
    labelFor,
    resolveRow,
    setRowCategory,
    setLinking,
  };
  const table = useTable({
    features: dataGridFeatures,
    columns,
    data: rows,
    getRowId: (item) => item.id,
    meta: categorizeMeta,
    enableMultiSort: false,
    enableSortingRemoval: false,
    state: { sorting },
    onSortingChange,
  });

  // --- Bulk ---------------------------------------------------------------
  const selected = rows.filter((item) => selection.isSelected(item.id));
  const toCategorize = selected.filter(categorizable);
  const skipped = selected.length - toCategorize.length;
  const kinds = new Set(toCategorize.map((item) => item.direction));
  const mixed = kinds.size > 1;
  const bulkChoices = mixed
    ? []
    : kinds.has("income")
      ? incomeCategories
      : expenseCategories;
  const keepable = selected.filter((item) => item.state != null);
  const acceptable = selected.filter(
    (item) => item.state === "remote_changed" || item.state === "remote_deleted",
  );

  function applyBulkCategory(category: string) {
    if (!category || toCategorize.length === 0 || mixed) return;
    const chosen = toCategorize.map((item) => item.id);
    setBulkCategory(category);
    bulkCategorize.mutate(
      { ids: chosen, category },
      {
        onSuccess: () => {
          selection.clear();
          toast.success(
            `Categorized ${entries(chosen.length)} as ${labelFor(kinds.has("income") ? "income" : "expense", category)}` +
              (skipped > 0 ? ` · ${skipped} deleted in Folio skipped` : ""),
          );
        },
        onError: (error) => bulkError(error, "Could not categorize the entries", byId),
        onSettled: () => setBulkCategory(""),
      },
    );
  }

  function runBulkResolve(items: FolioImportItem[], accept: boolean) {
    if (items.length === 0) return;
    const mutation = accept ? bulkAccept : bulkKeep;
    mutation.mutate(
      items.map((item) => item.id),
      {
        onSuccess: () => {
          selection.clear();
          toast.success(
            accept
              ? `Accepted the Folio version of ${entries(items.length)}`
              : `Kept the Atlas version of ${entries(items.length)}`,
          );
        },
        onError: (error) =>
          bulkError(
            error,
            accept ? "Could not apply the Folio versions" : "Could not keep the entries",
            byId,
          ),
      },
    );
  }

  function startBulkAccept() {
    // Accepting a deletion removes the entry from Atlas: ask first.
    if (acceptable.some((item) => item.state === "remote_deleted")) {
      setConfirmAccept(acceptable);
      return;
    }
    runBulkResolve(acceptable, true);
  }

  // --- Render -------------------------------------------------------------
  const filtered =
    params.status !== DEFAULT_STATUS ||
    params.direction !== "" ||
    params.category !== "" ||
    params.q.trim() !== "";
  const total = imports.data?.total ?? allItems.length;

  const toolbar = (
    <div className="grid gap-2">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={searchRef}
          type="search"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (searchText) setSearchText("");
              else event.currentTarget.blur();
            }
          }}
          placeholder="Search descriptions and notes"
          aria-label="Search imported entries"
          className="h-9 w-full rounded-md border border-input bg-transparent pl-8 pr-8 text-base shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring sm:text-sm [&::-webkit-search-cancel-button]:hidden"
        />
        {searchText && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setSearchText("");
              searchRef.current?.focus();
            }}
            className="absolute right-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Filter by status"
          value={params.status}
          onChange={(event) => setParams({ status: event.target.value as StatusFilter })}
          className={cn(selectClassName, params.status !== DEFAULT_STATUS && "border-primary/60")}
        >
          {STATUS_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by direction"
          value={params.direction}
          onChange={(event) =>
            setParams({ direction: event.target.value as Direction | "" })
          }
          className={cn(selectClassName, params.direction && "border-primary/60")}
        >
          <option value="">All directions</option>
          <option value="expense">Expenses</option>
          <option value="refund">Refunds</option>
          <option value="income">Income</option>
        </select>
        <select
          aria-label="Filter by category"
          value={params.category}
          onChange={(event) => setParams({ category: event.target.value })}
          className={cn(selectClassName, params.category && "border-primary/60")}
        >
          <option value="">All categories</option>
          {categoryOptions.map((value) => (
            <option key={value} value={value}>
              {anyLabel(value)}
            </option>
          ))}
          {params.category && !categoryOptions.includes(params.category) ? (
            <option value={params.category}>{anyLabel(params.category)}</option>
          ) : null}
        </select>
        {filtered && (
          <Button
            type="button"
            size="sm"
            variant="link"
            className="h-7 px-1 text-xs"
            onClick={() => {
              setSearchText("");
              setParams({ status: DEFAULT_STATUS, direction: "", category: "", q: "" });
            }}
          >
            Reset filters
          </Button>
        )}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {rows.length} of {allItems.length} shown
        </span>
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (imports.isPending) {
    body = (
      <div className="grid gap-2" aria-busy="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  } else if (imports.isError) {
    body = (
      <div className="grid justify-items-center gap-3 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          {errorMessage(imports.error, "Could not load the imported entries.")}
        </p>
        <Button type="button" size="sm" onClick={() => void imports.refetch()}>
          Retry
        </Button>
      </div>
    );
  } else if (allItems.length === 0) {
    body = (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Nothing has been imported from Folio yet.{" "}
        <Link href="/admin#gnucash" className="underline">
          Import settings
        </Link>
      </p>
    );
  } else {
    body = (
      <div className="rounded-xl border">
        <DataGrid
          table={table}
          aria-label="Imported entries"
          // A wide editing grid (category picker, sale link, conflict
          // actions per row): it keeps every column and scrolls sideways on
          // a laptop rather than folding into tiles; phones still get cards.
          cardMode="phone"
          searchable={false}
          selection={selection}
          selectAllLabel="Select all shown entries"
          getRowLabel={(item) => `Select ${item.description}`}
          emptyMessage={
            params.status === "attention" && !filtered
              ? "Everything imported has a category. Nothing needs attention."
              : "No entries match these filters."
          }
          rowProps={(item) => (item.deleted ? { className: "opacity-60" } : undefined)}
        />
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <PageHeader
        subtitle="Give each entry imported from Folio a category, one row or many at a time. The Folio transaction stays as it is."
        actions={
          <>
            <Link
              href="/sales/expenses"
              className="inline-flex min-h-9 items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              <ArrowLeft className="size-3.5" />
              Expenses
            </Link>
            <Link
              href={FINANCE_CATEGORIES_HREF}
              className="inline-flex min-h-9 items-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Manage categories
            </Link>
          </>
        }
      />
      {toolbar}
      <p className="text-xs text-muted-foreground">
        Click selects a row, Shift-click selects a range, Ctrl/⌘-click adds or
        removes one, Ctrl/⌘+A selects every shown row, Esc clears.
      </p>
      {total > allItems.length ? (
        <p className="rounded-md border border-warning/40 bg-warning/5 p-2 text-xs">
          Showing the first {allItems.length} of {total} imported entries —
          everything that needs attention is listed first.
        </p>
      ) : null}
      {body}

      {selection.count > 0 && (
        <div
          role="region"
          aria-label="Bulk actions"
          className="sticky bottom-[calc(var(--bottom-nav-h,0px)+0.75rem)] z-20 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3 shadow-lg lg:bottom-4"
        >
          <span className="text-sm font-medium" aria-live="polite">
            {selection.count} selected
          </span>
          {mixed ? (
            <span className="text-xs text-muted-foreground">
              Select only expenses or only income to set a category.
            </span>
          ) : toCategorize.length > 0 ? (
            <Select
              value={bulkCategory}
              onValueChange={applyBulkCategory}
              disabled={busy}
            >
              <SelectTrigger className="h-8 w-52" aria-label="Set category for selected">
                <SelectValue placeholder="Set category…" />
              </SelectTrigger>
              <SelectContent>
                {bulkChoices.map((value) => (
                  <SelectItem key={value} value={value}>
                    {labelFor(kinds.has("income") ? "income" : "expense", value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-xs text-muted-foreground">
              Entries deleted in Folio can&apos;t be categorized.
            </span>
          )}
          {!mixed && skipped > 0 && toCategorize.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              {skipped} deleted in Folio will be skipped
            </span>
          ) : null}
          {keepable.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => runBulkResolve(keepable, false)}
            >
              Keep Atlas version ({keepable.length})
            </Button>
          )}
          {acceptable.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={startBulkAccept}
            >
              Accept Folio ({acceptable.length})
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={selection.clear}>
            Clear
            <kbd className="rounded border bg-muted px-1 font-mono text-[11px]">Esc</kbd>
          </Button>
        </div>
      )}

      <Dialog
        open={linking !== null}
        onOpenChange={(open) => {
          if (!open) setLinking(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link to a sale</DialogTitle>
            <DialogDescription>
              {linking
                ? `${linking.description} · ${formatDate(linking.date)} · ${formatFolioAmount(linking.direction, linking.amount, formatMoney)}`
                : null}
            </DialogDescription>
          </DialogHeader>
          {linking ? (
            <FolioSaleLinker item={linking} onDone={() => setLinking(null)} />
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmAccept !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAccept(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Accept the Folio version of {entries(confirmAccept?.length ?? 0)}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const removals =
                  confirmAccept?.filter((item) => item.state === "remote_deleted").length ?? 0;
                return `${entries(removals)} deleted in Folio will be removed from Atlas; changed entries take Folio's amount, date and description.`;
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const items = confirmAccept ?? [];
                setConfirmAccept(null);
                runBulkResolve(items, true);
              }}
            >
              Accept Folio
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
