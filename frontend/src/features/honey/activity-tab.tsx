"use client";

/**
 * Activity: the honey ledger as a register, rebuilt on the Folio account
 * ledger's model.
 *
 * - Infinite scroll: GET /honey/activity pages by keyset cursor (newest
 *   first, ties broken by id) and a sentinel below the grid asks for the next
 *   page as it nears the viewport. Type and search filters are applied by
 *   the server, so every page is a page of the filtered ledger.
 * - Day grouping: a section header per day with that day's entry count and
 *   sales total over the rows loaded so far.
 * - Desktop selection (DataGrid `selection`): click selects one row,
 *   shift-click the range from the anchor — across loaded pages —,
 *   ctrl/cmd-click toggles, Space / shift+arrow from the keyboard, Escape
 *   clears, Ctrl/Cmd+A or `x` selects every loaded row.
 *
 * The ledger is append-only: movements are reversed with a negating entry
 * and sales are cancelled in place — nothing is deleted.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createColumnHelper, useTable } from "@tanstack/react-table";
import {
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

import { useHoneyActivity } from "./activity-hooks";
import { formatDate, formatMoney } from "./format";
import { useDeleteTimelineEntries } from "./hooks";
import type { TimelineEntry } from "./types";

interface KindStyle {
  icon: LucideIcon;
  label: string;
  /** Filter chip label. */
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

const columnHelper = createColumnHelper<typeof dataGridFeatures, TimelineEntry>();

function isCorrected(entry: TimelineEntry): boolean {
  return Boolean(entry.isReversal || entry.cancelled);
}

/** Day key for grouping; the same UTC calendar day `formatDate` prints. */
function dayKey(entry: TimelineEntry): string {
  return entry.date.slice(0, 10);
}

function parseTypes(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((type) => type.trim())
    .filter((type) => FILTER_TYPES.includes(type));
}

type ConfirmTarget =
  | { kind: "single"; entry: TimelineEntry }
  | { kind: "bulk"; entries: TimelineEntry[]; skipped: number };

export function ActivityTab() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { formatHoney } = useUnits();

  // Filters live in the URL so a reload or a shared link keeps them.
  const types = React.useMemo(
    () => parseTypes(searchParams.get("type")),
    [searchParams],
  );
  const q = searchParams.get("q") ?? "";
  const [searchText, setSearchText] = React.useState(q);
  const searchRef = React.useRef<HTMLInputElement>(null);

  const activity = useHoneyActivity({ types, q });
  const deleteEntries = useDeleteTimelineEntries();
  const [confirmTarget, setConfirmTarget] = React.useState<ConfirmTarget | null>(
    null,
  );

  // Every loaded page, in order. Keyset pages never overlap, but a row can
  // shift pages if the ledger changes between fetches; keep the first copy.
  const entries = React.useMemo(() => {
    const seen = new Set<string>();
    const out: TimelineEntry[] = [];
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

  const setFilters = React.useCallback(
    (next: { types?: string[]; q?: string }) => {
      const params = new URLSearchParams(searchParams.toString());
      const nextTypes = next.types ?? types;
      const nextQ = (next.q ?? q).trim();
      if (nextTypes.length > 0) params.set("type", nextTypes.join(","));
      else params.delete("type");
      if (nextQ) params.set("q", nextQ);
      else params.delete("q");
      const query = params.toString();
      // A selection belongs to the rows it was made on.
      clearSelection();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [searchParams, types, q, pathname, router, clearSelection],
  );

  // Search is debounced into the URL (and so into the query key).
  React.useEffect(() => {
    if (searchText.trim() === q.trim()) return;
    const timer = window.setTimeout(() => setFilters({ q: searchText }), 300);
    return () => window.clearTimeout(timer);
  }, [searchText, q, setFilters]);

  function toggleType(type: string) {
    setFilters({
      types: types.includes(type)
        ? types.filter((t) => t !== type)
        : [...types, type],
    });
  }

  useShortcut("x", "Select all loaded activity rows", () => {
    if (selection.allSelected) selection.clear();
    else selection.selectAll();
  });

  const reversible = React.useCallback(
    (entry: TimelineEntry) => !isCorrected(entry),
    [],
  );

  const columns = React.useMemo(
    () =>
      columnHelper.columns([
        columnHelper.display({
          id: "kind",
          header: "Kind",
          meta: { headClassName: "w-36" } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) => {
            const style = KIND_STYLES[entry.type] ?? FALLBACK_STYLE;
            const Icon = style.icon;
            return (
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full",
                    style.iconClass,
                  )}
                >
                  <Icon className="size-3.5" />
                </span>
                <span className="text-xs font-medium text-muted-foreground">
                  {style.label}
                </span>
              </span>
            );
          },
        }),
        columnHelper.display({
          id: "description",
          header: "Entry",
          meta: {
            cellClassName: "w-full min-w-[14rem] whitespace-normal",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) => (
            <div className="min-w-0">
              <p
                className={cn(
                  "text-sm font-medium",
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
              </p>
              {entry.notes && (
                <p className="text-xs text-muted-foreground">{entry.notes}</p>
              )}
            </div>
          ),
        }),
        columnHelper.display({
          id: "amount",
          header: "Amount",
          meta: {
            align: "right",
            cellClassName: "tabular-nums",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: entry } }) =>
            entry.totalAmount != null
              ? formatMoney(entry.totalAmount)
              : entry.amountLbs != null
                ? formatHoney(entry.amountLbs)
                : entry.quantity != null
                  ? `${entry.quantity > 0 ? "+" : ""}${entry.quantity} jars`
                  : "—",
        }),
        columnHelper.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          meta: { headClassName: "w-12" } satisfies DataGridColumnMeta,
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
                      : `Reverse ${(KIND_STYLES[entry.type] ?? FALLBACK_STYLE).label.toLowerCase()} entry`
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

  const filtered = types.length > 0 || q.trim() !== "";
  const selectedCount = selection.count;
  const selectionText =
    selection.allSelected && hasNextPage
      ? `${selectedCount} loaded rows selected`
      : `${selectedCount} selected`;

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
          placeholder="Search the ledger — customer, location, jar size, notes"
          aria-label="Search activity"
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
        aria-label="Filter by kind"
        className="flex flex-wrap items-center gap-1.5"
      >
        {FILTER_TYPES.map((type) => {
          const active = types.includes(type);
          return (
            <Button
              key={type}
              type="button"
              size="sm"
              variant={active ? "secondary" : "ghost"}
              aria-pressed={active}
              className={cn("h-7 px-2 text-xs", active && "ring-1 ring-primary/40")}
              onClick={() => toggleType(type)}
            >
              {KIND_STYLES[type].filterLabel}
            </Button>
          );
        })}
        {filtered && (
          <Button
            type="button"
            size="sm"
            variant="link"
            className="h-7 px-1 text-xs"
            onClick={() => {
              setSearchText("");
              setFilters({ types: [], q: "" });
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
            : "Could not load the activity ledger."}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/production">Back to Honey</Link>
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
          : "No activity yet. Jar honey or record a sale to get started."}
      </p>
    );
  } else {
    body = (
      <>
        <div className="rounded-xl border">
          <DataGrid
            table={table}
            aria-label="Honey activity"
            searchable={false}
            selection={selection}
            selectAllLabel="Select all loaded activity rows"
            getRowLabel={(entry) => `Select ${entry.description}`}
            getRowGroup={dayKey}
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
              Scroll or click for older entries
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
        Click selects a row, Shift-click selects a range, Ctrl/⌘-click adds or
        removes one. Enter or double-click opens a sale.
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
