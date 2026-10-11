"use client";

/**
 * Stock › Movements: the inventory movement ledger as a TanStack DataGrid,
 * rebuilt on the Folio account ledger's model.
 *
 * - Server-side everything: GET /honey/activity pages by keyset cursor in the
 *   chosen sort (date, quantity, type or item; ties broken by id), and the
 *   Type, Item, Varietal, Location and search filters are applied by the
 *   server, so every page is a page of the sorted, filtered ledger. Header
 *   clicks drive that sort (`manualSorting`) and start paging over; sort and
 *   filters live in the URL.
 * - Infinite scroll: a sentinel below the grid asks for the next page as it
 *   nears the viewport.
 * - Day grouping while sorted by date: a section header per day with that
 *   day's entry count and sales total over the rows loaded so far. Other
 *   sorts break days apart, so they drop the headers.
 * - Desktop selection (DataGrid `selection`): click selects one row,
 *   shift-click the range from the anchor — across loaded pages, in the
 *   on-screen order —, ctrl/cmd-click toggles, Space / shift+arrow from the
 *   keyboard, Escape clears, Ctrl/Cmd+A or `x` selects every loaded row.
 * - Phones get cards: type icon + entry as the title, then qty, item, lot
 *   and location lines, with reverse as the card action.
 *
 * The ledger is append-only: movements are reversed with a negating entry
 * and sales are cancelled in place — nothing is deleted.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createColumnHelper, useTable } from "@tanstack/react-table";
import type { SortingState, Updater } from "@tanstack/react-table";
import {
  ArrowRight,
  DollarSign,
  Gift,
  Loader2,
  Package,
  PackagePlus,
  Search,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Utensils,
  X,
  type LucideIcon,
} from "lucide-react";

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
import { Button } from "@/components/ui/button";
import {
  DataGrid,
  DataGridCellAction,
  dataGridFeatures,
  type DataGridColumnMeta,
} from "@/components/ui/data-grid";
import { Skeleton } from "@/components/ui/skeleton";
import { useShortcut } from "@/components/shortcuts/provider";
import { ApiError } from "@/lib/api";
import { useInfiniteSentinel } from "@/lib/use-infinite-sentinel";
import { useRowSelection } from "@/lib/use-row-selection";
import { useUnits } from "@/lib/use-units";
import { cn } from "@/lib/utils";

import {
  useHoneyActivity,
  useHoneyActivityFacets,
  type ActivityEntry,
  type ActivityFacet,
  type ActivitySortKey,
  type SortDir,
} from "./activity-hooks";
import { formatDate, formatMoney } from "./format";
import { useDeleteTimelineEntries } from "./hooks";

interface KindStyle {
  icon: LucideIcon;
  label: string;
  /** Type filter option label. */
  filterLabel: string;
  iconClass: string;
}

const KIND_STYLES: Record<string, KindStyle> = {
  jarring: {
    icon: Package,
    label: "Jarring",
    filterLabel: "Jarring",
    iconClass: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  sale: {
    icon: DollarSign,
    label: "Sale",
    filterLabel: "Sales",
    iconClass: "bg-green-600/15 text-green-700 dark:text-green-400",
  },
  give_away: {
    icon: Gift,
    label: "Give-away",
    filterLabel: "Give-aways",
    iconClass: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  },
  bulk_use: {
    icon: Utensils,
    label: "Bulk use",
    filterLabel: "Bulk use",
    iconClass: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  },
  loss: {
    icon: TriangleAlert,
    label: "Loss",
    filterLabel: "Loss",
    iconClass: "bg-red-500/15 text-red-600 dark:text-red-400",
  },
  jar_adjustment: {
    icon: SlidersHorizontal,
    label: "Adjustment",
    filterLabel: "Adjustments",
    iconClass: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
  },
  receipt: {
    icon: PackagePlus,
    label: "Receipt",
    filterLabel: "Receipts",
    iconClass: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  },
};

const FILTER_TYPES = Object.keys(KIND_STYLES);
const FALLBACK_STYLE: KindStyle = KIND_STYLES.jar_adjustment;

function kindStyle(type: string): KindStyle {
  return KIND_STYLES[type] ?? FALLBACK_STYLE;
}

/** The colored type badge — the ledger's signature, kept from the old list. */
function KindIcon({ type, className }: { type: string; className?: string }) {
  const style = kindStyle(type);
  const Icon = style.icon;
  return (
    <span
      data-kind-icon={type}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full",
        style.iconClass,
        className,
      )}
    >
      <Icon className="size-3.5" />
    </span>
  );
}

// --- URL state -------------------------------------------------------------

/** Column id ↔ server sort key. */
const SORT_COLUMNS: Record<ActivitySortKey, string> = {
  date: "date",
  type: "type",
  item: "item",
  quantity: "qty",
};
const COLUMN_SORTS: Record<string, ActivitySortKey> = Object.fromEntries(
  Object.entries(SORT_COLUMNS).map(([sort, column]) => [column, sort]),
) as Record<string, ActivitySortKey>;

const DEFAULT_SORT: ActivitySortKey = "date";
const DEFAULT_DIR: SortDir = "desc";

function parseList(raw: string | null, valid?: (value: string) => boolean): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "" && (!valid || valid(value)));
}

function parseSort(raw: string | null): ActivitySortKey {
  return raw && raw in SORT_COLUMNS ? (raw as ActivitySortKey) : DEFAULT_SORT;
}

function parseDir(raw: string | null, sort: ActivitySortKey): SortDir {
  if (raw === "asc" || raw === "desc") return raw;
  return sort === DEFAULT_SORT ? DEFAULT_DIR : "asc";
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

interface LedgerParams {
  types: string[];
  items: string[];
  varietals: string[];
  locations: string[];
  q: string;
  sort: ActivitySortKey;
  dir: SortDir;
}

const LIST_PARAMS = {
  types: "type",
  items: "item",
  varietals: "varietal",
  locations: "location",
} as const;

// --- Row helpers -----------------------------------------------------------

const columnHelper = createColumnHelper<typeof dataGridFeatures, ActivityEntry>();

function isCorrected(entry: ActivityEntry): boolean {
  return Boolean(entry.isReversal || entry.cancelled);
}

/** Day key for grouping; the same UTC calendar day `formatDate` prints. */
function dayKey(entry: ActivityEntry): string {
  return entry.date.slice(0, 10);
}

/** The signed quantity and its unit, tolerating rows without ledger columns. */
function signedQuantity(entry: ActivityEntry): { value: number; unit: string } | null {
  const unit =
    entry.qtyUnit ??
    (entry.quantity != null ? "jars" : entry.amountLbs != null ? "lbs" : "");
  const value =
    entry.qty ??
    (unit === "jars"
      ? (entry.type === "sale" ? -1 : 1) * (entry.quantity ?? 0)
      : (entry.amountLbs ?? 0));
  if (!unit || value === 0) return null;
  return { value, unit };
}

function locationText(entry: ActivityEntry): string {
  const from = entry.fromLocation ?? "";
  const to = entry.toLocation ?? "";
  if (from && to && from !== to) return `${from} → ${to}`;
  return from || to;
}

function lotText(entry: ActivityEntry): string {
  return entry.varietal ?? entry.lotCode ?? "";
}

type ConfirmTarget =
  | { kind: "single"; entry: ActivityEntry }
  | { kind: "bulk"; entries: ActivityEntry[]; skipped: number };

const selectClassName =
  "h-8 min-w-0 max-w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** A server-side column filter: one choice (or all), written to the URL. */
function FilterSelect({
  label,
  allLabel,
  values,
  options,
  onChange,
}: {
  label: string;
  allLabel: string;
  values: string[];
  options: ActivityFacet[];
  onChange: (values: string[]) => void;
}) {
  // A shared link may carry several values or one the facets no longer list;
  // show it rather than silently reading as "all".
  const known = new Set(options.map((option) => option.value));
  const extra = values.filter((value) => !known.has(value));
  const value = values.length > 1 ? "__multiple__" : (values[0] ?? "");
  return (
    <select
      aria-label={`Filter by ${label.toLowerCase()}`}
      value={value}
      onChange={(event) =>
        onChange(event.target.value ? [event.target.value] : [])
      }
      className={cn(selectClassName, values.length > 0 && "border-primary/60")}
    >
      <option value="">{allLabel}</option>
      {values.length > 1 && (
        <option value="__multiple__" disabled>
          {values.length} {label.toLowerCase()} values
        </option>
      )}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
      {values.length === 1 &&
        extra.map((value) => (
          <option key={value} value={value}>
            Unknown {label.toLowerCase()}
          </option>
        ))}
    </select>
  );
}

export function ActivityTab() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { formatHoney } = useUnits();

  // Sort and filters live in the URL so a reload or a shared link keeps them.
  const params = React.useMemo<LedgerParams>(() => {
    const sort = parseSort(searchParams.get("sort"));
    return {
      types: parseList(searchParams.get("type"), (t) => FILTER_TYPES.includes(t)),
      items: parseList(searchParams.get("item")),
      varietals: parseList(searchParams.get("varietal")),
      locations: parseList(searchParams.get("location")),
      q: searchParams.get("q") ?? "",
      sort,
      dir: parseDir(searchParams.get("dir"), sort),
    };
  }, [searchParams]);
  const { q, sort, dir } = params;
  const [searchText, setSearchText] = React.useState(q);
  const searchRef = React.useRef<HTMLInputElement>(null);

  const activity = useHoneyActivity(params);
  const facets = useHoneyActivityFacets();
  const deleteEntries = useDeleteTimelineEntries();
  const [confirmTarget, setConfirmTarget] = React.useState<ConfirmTarget | null>(
    null,
  );

  // Every loaded page, in the server's order. Keyset pages never overlap, but
  // a row can shift pages if the ledger changes between fetches; keep the
  // first copy.
  const entries = React.useMemo(() => {
    const seen = new Set<string>();
    const out: ActivityEntry[] = [];
    for (const page of activity.data?.pages ?? []) {
      for (const entry of page.entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push(entry);
      }
    }
    return out;
  }, [activity.data]);
  const ids = React.useMemo(() => entries.map((entry) => entry.id), [entries]);
  const selection = useRowSelection(ids);
  const clearSelection = selection.clear;

  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } =
    activity;
  const loadMore = React.useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const sentinelRef = useInfiniteSentinel(loadMore, {
    enabled: Boolean(hasNextPage) && !isFetchingNextPage && !isFetchNextPageError,
  });

  // Every URL update merges onto the newest query — including one written a
  // moment ago whose navigation has not landed yet. `router.replace` is
  // asynchronous, so building from the rendered `searchParams` lost a filter
  // picked just before typing a search (the debounced search wrote over it).
  // `pendingQueryRef` holds the last query we wrote until the URL catches up;
  // `renderedQueryRef` is the URL as last rendered (back/forward included).
  const renderedQuery = searchParams.toString();
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
    (next: Partial<LedgerParams>) => {
      const query = new URLSearchParams(
        pendingQueryRef.current ?? renderedQueryRef.current,
      );
      // Only the keys this update names change; everything else is kept.
      for (const [key, name] of Object.entries(LIST_PARAMS)) {
        const values = next[key as keyof typeof LIST_PARAMS];
        if (values === undefined) continue;
        if (values.length > 0) query.set(name, values.join(","));
        else query.delete(name);
      }
      if (next.q !== undefined) {
        const nextQ = next.q.trim();
        if (nextQ) query.set("q", nextQ);
        else query.delete("q");
      }
      if (next.sort !== undefined || next.dir !== undefined) {
        const sort = next.sort ?? parseSort(query.get("sort"));
        const dir = next.dir ?? parseDir(query.get("dir"), sort);
        // The default order (newest first) keeps the URL clean.
        if (sort === DEFAULT_SORT && dir === DEFAULT_DIR) {
          query.delete("sort");
          query.delete("dir");
        } else {
          query.set("sort", sort);
          query.set("dir", dir);
        }
      }
      const search = query.toString();
      const current = pendingQueryRef.current ?? renderedQueryRef.current;
      if (sameQuery(search, current)) return;
      pendingQueryRef.current = search;
      // A selection belongs to the rows (and the order) it was made on.
      clearSelection();
      router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
    },
    [pathname, router, clearSelection],
  );

  // Search is debounced into the URL (and so into the query key).
  React.useEffect(() => {
    if (searchText.trim() === q.trim()) return;
    const timer = window.setTimeout(() => setParams({ q: searchText }), 300);
    return () => window.clearTimeout(timer);
  }, [searchText, q, setParams]);

  useShortcut("x", "Select all loaded movement rows", () => {
    if (selection.allSelected) selection.clear();
    else selection.selectAll();
  });

  const reversible = React.useCallback(
    (entry: ActivityEntry) => !isCorrected(entry),
    [],
  );

  // The table's sorting is the URL's: header clicks become a server sort.
  const sorting = React.useMemo<SortingState>(
    () => [{ id: SORT_COLUMNS[sort], desc: dir === "desc" }],
    [sort, dir],
  );
  const onSortingChange = React.useCallback(
    (updater: Updater<SortingState>) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      const first = next[0];
      const nextSort = first ? COLUMN_SORTS[first.id] : undefined;
      if (!first || !nextSort) {
        // "Default order" (the phone sort select) is newest first.
        setParams({ sort: DEFAULT_SORT, dir: DEFAULT_DIR });
        return;
      }
      setParams({ sort: nextSort, dir: first.desc ? "desc" : "asc" });
    },
    [sorting, setParams],
  );

  const columns = React.useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor((entry) => entry.date, {
          id: "date",
          header: "Date",
          sortDescFirst: true,
          meta: {
            card: "subtitle",
            headClassName: "w-28",
            cellClassName: "tabular-nums text-muted-foreground",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) => formatDate(entry.date),
        }),
        columnHelper.accessor((entry) => kindStyle(entry.type).label, {
          id: "type",
          header: "Type",
          meta: { card: "hidden", headClassName: "w-36" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) => (
            <span className="flex items-center gap-2">
              <KindIcon type={entry.type} />
              <span className="text-xs font-medium text-muted-foreground">
                {kindStyle(entry.type).label}
              </span>
            </span>
          ),
        }),
        columnHelper.display({
          id: "description",
          header: "Entry",
          meta: {
            card: "title",
            cellClassName: "min-w-[12rem] whitespace-normal",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) => (
            <span className="flex min-w-0 items-center gap-2">
              {/* Cards (below md) have no Type column: the badge leads the title. */}
              <KindIcon type={entry.type} className="md:hidden" />
              <span
                className={cn(
                  "min-w-0 text-sm font-medium",
                  entry.cancelled && "line-through",
                )}
              >
                {entry.type === "sale" ? (
                  <Link
                    href={`/sales/${entry.id}`}
                    className="underline-offset-4 hover:underline"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {entry.description}
                  </Link>
                ) : (
                  entry.description
                )}
              </span>
            </span>
          ),
        }),
        columnHelper.accessor((entry) => signedQuantity(entry)?.value ?? 0, {
          id: "qty",
          header: "Qty",
          meta: {
            align: "right",
            cellClassName: "tabular-nums",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) => {
            const qty = signedQuantity(entry);
            if (!qty) return <span className="text-muted-foreground">—</span>;
            const sign = qty.value > 0 ? "+" : "−";
            const amount = Math.abs(qty.value);
            const text =
              qty.unit === "lbs"
                ? formatHoney(amount)
                : `${amount} ${qty.unit === "jars" ? (amount === 1 ? "jar" : "jars") : amount === 1 ? "item" : "items"}`;
            return (
              <span
                className={cn(
                  qty.value > 0
                    ? "text-green-700 dark:text-green-400"
                    : "text-foreground",
                )}
              >
                {sign}
                {text}
              </span>
            );
          },
        }),
        columnHelper.accessor((entry) => entry.item ?? "", {
          id: "item",
          header: "Item",
          meta: { cellClassName: "whitespace-normal" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) =>
            entry.item ? (
              <span>
                {entry.item}
                {(entry.itemCount ?? 0) > 1 && (
                  <span className="text-muted-foreground">
                    {" "}
                    +{(entry.itemCount ?? 1) - 1}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            ),
        }),
        columnHelper.accessor(lotText, {
          id: "lot",
          header: "Lot",
          enableSorting: false,
          meta: {
            label: "Lot",
            cellClassName: "whitespace-normal",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) =>
            entry.varietal || entry.lotCode ? (
              <span>
                {entry.varietal ?? entry.lotCode}
                {entry.varietal && entry.lotCode && (
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    · {entry.lotCode}
                  </span>
                )}
                {(entry.lotCount ?? 0) > 1 && (
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    +{(entry.lotCount ?? 1) - 1} lots
                  </span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            ),
        }),
        columnHelper.accessor(locationText, {
          id: "location",
          header: "Location",
          enableSorting: false,
          meta: { cellClassName: "whitespace-normal" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) => {
            const from = entry.fromLocation ?? "";
            const to = entry.toLocation ?? "";
            if (!from && !to) return <span className="text-muted-foreground">—</span>;
            if (!from || !to || from === to) return from || to;
            return (
              <span className="inline-flex flex-wrap items-center gap-1">
                {from}
                <ArrowRight aria-label="to" className="size-3 text-muted-foreground" />
                {to}
              </span>
            );
          },
        }),
        columnHelper.accessor((entry) => entry.totalAmount ?? null, {
          id: "value",
          header: "Value",
          enableSorting: false,
          meta: {
            align: "right",
            cellClassName: "tabular-nums",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) =>
            entry.totalAmount != null ? (
              formatMoney(entry.totalAmount)
            ) : (
              <span className="text-muted-foreground">—</span>
            ),
        }),
        columnHelper.accessor((entry) => entry.notes ?? "", {
          id: "notes",
          header: "Notes",
          enableSorting: false,
          meta: {
            card: "subtitle",
            // First to fold into the row's detail line on a narrow window.
            priority: "secondary",
            cellClassName:
              "min-w-[7rem] max-w-[16rem] whitespace-normal text-xs text-muted-foreground",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) => entry.notes ?? null,
        }),
        columnHelper.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          meta: { card: "actions", headClassName: "w-12" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) =>
            reversible(entry) ? (
              <DataGridCellAction>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={
                    entry.type === "sale"
                      ? "Cancel sale"
                      : `Reverse ${kindStyle(entry.type).label.toLowerCase()} entry`
                  }
                  onClick={() => setConfirmTarget({ kind: "single", entry })}
                >
                  <Trash2 className="size-4" />
                </Button>
              </DataGridCellAction>
            ) : null,
        }),
      ]),
    [formatHoney, reversible],
  );

  const table = useTable({
    features: dataGridFeatures,
    columns,
    data: entries,
    getRowId: (entry) => entry.id,
    // The server sorts; the table only shows and drives that order.
    manualSorting: true,
    enableMultiSort: false,
    enableSortingRemoval: false,
    state: { sorting },
    onSortingChange,
  });

  // Day summaries over the loaded rows (the Folio ledger's running context).
  const daySummaries = React.useMemo(() => {
    const byDay = new Map<string, { count: number; sold: number }>();
    for (const entry of entries) {
      const key = dayKey(entry);
      const summary = byDay.get(key) ?? { count: 0, sold: 0 };
      summary.count += 1;
      if (entry.type === "sale" && !entry.cancelled && entry.totalAmount != null) {
        summary.sold += entry.totalAmount;
      }
      byDay.set(key, summary);
    }
    return byDay;
  }, [entries]);

  function openBulkConfirm() {
    const chosen = entries.filter((entry) => selection.isSelected(entry.id));
    const targets = chosen.filter(reversible);
    setConfirmTarget({
      kind: "bulk",
      entries: targets,
      skipped: chosen.length - targets.length,
    });
  }

  function runDelete() {
    if (!confirmTarget) return;
    const targets = (
      confirmTarget.kind === "single" ? [confirmTarget.entry] : confirmTarget.entries
    ).map((entry) => ({ id: entry.id, type: entry.type }));
    const bulk = confirmTarget.kind === "bulk";
    setConfirmTarget(null);
    if (targets.length === 0) return;
    deleteEntries.mutate(targets, {
      onSettled: () => {
        if (bulk) selection.clear();
      },
    });
  }

  const filtered =
    params.types.length > 0 ||
    params.items.length > 0 ||
    params.varietals.length > 0 ||
    params.locations.length > 0 ||
    q.trim() !== "";
  const selectedCount = selection.count;
  const selectionText =
    selection.allSelected && hasNextPage
      ? `${selectedCount} loaded rows selected`
      : `${selectedCount} selected`;
  const typeOptions = React.useMemo(
    () =>
      FILTER_TYPES.map((type) => ({
        value: type,
        label: KIND_STYLES[type].filterLabel,
      })),
    [],
  );

  const toolbar = (
    <div className="sticky top-0 z-10 grid gap-2 border-b bg-background/95 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
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
          placeholder="Search the ledger — customer, location, jar size, lot, notes"
          aria-label="Search movements"
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
      <div
        role="group"
        aria-label="Column filters"
        className="flex flex-wrap items-center gap-2"
      >
        <FilterSelect
          label="Type"
          allLabel="All types"
          values={params.types}
          options={typeOptions}
          onChange={(types) => setParams({ types })}
        />
        <FilterSelect
          label="Item"
          allLabel="All items"
          values={params.items}
          options={facets.data?.items ?? []}
          onChange={(items) => setParams({ items })}
        />
        <FilterSelect
          label="Varietal"
          allLabel="All varietals"
          values={params.varietals}
          options={facets.data?.varietals ?? []}
          onChange={(varietals) => setParams({ varietals })}
        />
        <FilterSelect
          label="Location"
          allLabel="All locations"
          values={params.locations}
          options={facets.data?.locations ?? []}
          onChange={(locations) => setParams({ locations })}
        />
        {filtered && (
          <Button
            type="button"
            size="sm"
            variant="link"
            className="h-7 px-1 text-xs"
            onClick={() => {
              setSearchText("");
              setParams({ types: [], items: [], varietals: [], locations: [], q: "" });
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (activity.isPending) {
    body = (
      <div className="grid gap-2" aria-busy="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  } else if (activity.isError) {
    body = (
      <div className="grid justify-items-center gap-3 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          {activity.error instanceof ApiError && activity.error.status === 403
            ? "Administrator access required"
            : "Could not load the movement ledger."}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/stock">Back to Stock</Link>
          </Button>
          <Button type="button" size="sm" onClick={() => void activity.refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  } else if (entries.length === 0) {
    body = (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {filtered
          ? "No ledger entries match these filters."
          : "No movements yet. Jar honey or record a sale to get started."}
      </p>
    );
  } else {
    body = (
      <>
        <div className="rounded-xl border">
          <DataGrid
            table={table}
            aria-label="Stock movements"
            searchable={false}
            selection={selection}
            selectAllLabel="Select all loaded movement rows"
            getRowLabel={(entry) => `Select ${entry.description}`}
            // Days only hold together while the ledger is in date order.
            getRowGroup={sort === "date" ? dayKey : undefined}
            groupWhileSorted
            renderGroupHeader={(key) => {
              const summary = daySummaries.get(key);
              return (
                <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span>{formatDate(key)}</span>
                  {summary && (
                    <span className="font-normal normal-case tracking-normal tabular-nums">
                      {summary.count} {summary.count === 1 ? "entry" : "entries"}
                      {summary.sold > 0 ? ` · ${formatMoney(summary.sold)} sold` : ""}
                    </span>
                  )}
                </span>
              );
            }}
            onRowActivate={(entry) => {
              if (entry.type === "sale") router.push(`/sales/${entry.id}`);
            }}
            onRowDelete={(entry) => {
              if (reversible(entry)) setConfirmTarget({ kind: "single", entry });
            }}
            rowProps={(entry) =>
              isCorrected(entry) ? { className: "opacity-60" } : undefined
            }
          />
        </div>
        <div
          ref={sentinelRef}
          data-testid="activity-load-more"
          className="flex justify-center py-6 text-xs uppercase tracking-widest text-muted-foreground"
        >
          {isFetchingNextPage ? (
            <span role="status" className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Loading more…
            </span>
          ) : isFetchNextPageError ? (
            <span className="flex items-center gap-2 normal-case tracking-normal">
              Could not load more entries.
              <Button type="button" size="sm" variant="outline" onClick={loadMore}>
                Retry
              </Button>
            </span>
          ) : hasNextPage ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-xs uppercase tracking-widest text-muted-foreground"
              onClick={loadMore}
            >
              Scroll or click for more entries
            </Button>
          ) : (
            <span>
              End of ledger · {entries.length}{" "}
              {entries.length === 1 ? "entry" : "entries"}
            </span>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="grid gap-2">
      {toolbar}
      <p className="text-xs text-muted-foreground">
        Click a column header to sort. Click selects a row, Shift-click
        selects a range, Ctrl/⌘-click adds or removes one. Enter or
        double-click opens a sale.
      </p>
      {body}

      {selectedCount > 0 && (
        <div className="sticky bottom-[calc(var(--bottom-nav-h,0px)+0.75rem)] z-20 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3 shadow-lg lg:bottom-4">
          <span className="text-sm font-medium" aria-live="polite">
            {selectionText}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              selection.allSelected ? selection.clear() : selection.selectAll()
            }
          >
            {selection.allSelected ? "Clear all" : "Select all loaded"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={selection.clear}>
            Clear
            <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">
              Esc
            </kbd>
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="ml-auto"
            disabled={deleteEntries.isPending}
            onClick={openBulkConfirm}
          >
            <Trash2 />
            Reverse selected
          </Button>
        </div>
      )}

      <AlertDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmTarget?.kind === "bulk"
                ? confirmTarget.entries.length === 0
                  ? "Nothing to reverse"
                  : `Reverse ${confirmTarget.entries.length} ${confirmTarget.entries.length === 1 ? "entry" : "entries"}?`
                : confirmTarget?.kind === "single" &&
                    confirmTarget.entry.type === "sale"
                  ? "Cancel this sale?"
                  : "Reverse this entry?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmTarget?.kind === "single"
                ? confirmTarget.entry.type === "sale"
                  ? `"${confirmTarget.entry.description}" will be marked cancelled and its jars returned to inventory.`
                  : `A reversing entry will be recorded to undo "${confirmTarget.entry.description}".`
                : "Sales will be cancelled and movements undone with reversing entries."}{" "}
              {confirmTarget?.kind === "bulk" && confirmTarget.skipped > 0
                ? `${confirmTarget.skipped} already reversed or cancelled ${confirmTarget.skipped === 1 ? "entry is" : "entries are"} skipped. `
                : ""}
              The original records stay in the ledger.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep as is</AlertDialogCancel>
            {!(confirmTarget?.kind === "bulk" && confirmTarget.entries.length === 0) && (
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={runDelete}
              >
                {confirmTarget?.kind === "single" &&
                confirmTarget.entry.type === "sale"
                  ? "Cancel sale"
                  : "Reverse"}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
