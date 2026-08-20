"use client";

/**
 * Activity tab: the honey ledger timeline. Iconized, color-tinted rows per
 * kind, per-row reverse/cancel with confirm, and a bulk-select mode (`b`).
 * The ledger is append-only: movements are reversed with a negating entry
 * and sales are cancelled in place — nothing is deleted.
 */

import * as React from "react";
import Link from "next/link";
import {
  DollarSign,
  Gift,
  ListChecks,
  Package,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Utensils,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { useBulkSelect } from "@/lib/use-bulk-select";
import { cn } from "@/lib/utils";

import { useUnits } from "@/lib/use-units";

import { formatDate, formatMoney } from "./format";
import { useDeleteTimelineEntries, useHoneyTimeline } from "./hooks";
import type { TimelineEntry } from "./types";

interface KindStyle {
  icon: LucideIcon;
  label: string;
  iconClass: string;
  rowClass: string;
}

const KIND_STYLES: Record<string, KindStyle> = {
  jarring: {
    icon: Package,
    label: "Jarring",
    iconClass: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    rowClass: "border-amber-500/20 bg-amber-500/5",
  },
  sale: {
    icon: DollarSign,
    label: "Sale",
    iconClass: "bg-green-600/15 text-green-700 dark:text-green-400",
    rowClass: "border-green-600/20 bg-green-600/5",
  },
  bulk_use: {
    icon: Utensils,
    label: "Bulk use",
    iconClass: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    rowClass: "border-blue-500/20 bg-blue-500/5",
  },
  loss: {
    icon: TriangleAlert,
    label: "Loss",
    iconClass: "bg-red-500/15 text-red-600 dark:text-red-400",
    rowClass: "border-red-500/20 bg-red-500/5",
  },
  give_away: {
    icon: Gift,
    label: "Give-away",
    iconClass: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
    rowClass: "border-violet-500/20 bg-violet-500/5",
  },
  jar_adjustment: {
    icon: SlidersHorizontal,
    label: "Adjustment",
    iconClass: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
    rowClass: "border-slate-500/20 bg-slate-500/5",
  },
};

const FALLBACK_STYLE: KindStyle = KIND_STYLES.jar_adjustment;

export function ActivityTab() {
  const { formatHoney } = useUnits();
  const timeline = useHoneyTimeline(100);
  const deleteEntries = useDeleteTimelineEntries();

  const [confirmTarget, setConfirmTarget] = React.useState<
    { kind: "single"; entry: TimelineEntry } | { kind: "bulk" } | null
  >(null);
  const entries = timeline.data ?? [];
  const {
    bulkMode,
    selected,
    setSelected,
    toggle: toggleSelected,
    toggleMode,
    finish: finishBulk,
  } = useBulkSelect(
    entries.map((entry) => entry.id),
    { mode: "Bulk-select activity rows", selectAll: "Select all activity rows" },
  );

  function runDelete() {
    if (!confirmTarget) return;
    const targets =
      confirmTarget.kind === "single"
        ? [{ id: confirmTarget.entry.id, type: confirmTarget.entry.type }]
        : entries
            .filter((entry) => selected.has(entry.id))
            .map((entry) => ({ id: entry.id, type: entry.type }));
    setConfirmTarget(null);
    if (targets.length === 0) return;
    deleteEntries.mutate(targets, {
      onSettled: () => finishBulk(),
    });
  }

  if (timeline.isPending) {
    return (
      <div className="grid gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }
  if (timeline.isError) {
    return (
      <div className="grid justify-items-center gap-3 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          {timeline.error instanceof ApiError && timeline.error.status === 403
            ? "Administrator access required"
            : "Could not load the activity timeline."}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/harvest">Back to Honey</Link>
          </Button>
          <Button type="button" size="sm" onClick={() => void timeline.refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No activity yet. Jar honey or record a sale to get started.
      </p>
    );
  }

  const selectedCount = selected.size;

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Latest {entries.length} ledger entries
        </p>
        <Button
          type="button"
          variant={bulkMode ? "secondary" : "ghost"}
          size="sm"
          onClick={toggleMode}
        >
          <ListChecks />
          {bulkMode ? "Done" : "Select"}
          <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">
            b
          </kbd>
        </Button>
      </div>

      {bulkMode && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/50 px-3 py-2">
          <span className="text-sm">
            {selectedCount === 0
              ? "Select entries to reverse or cancel"
              : `${selectedCount} selected`}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setSelected(
                selectedCount === entries.length
                  ? new Set()
                  : new Set(entries.map((entry) => entry.id)),
              )
            }
          >
            {selectedCount === entries.length ? "Clear all" : "Select all"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="ml-auto"
            disabled={selectedCount === 0 || deleteEntries.isPending}
            onClick={() => setConfirmTarget({ kind: "bulk" })}
          >
            <Trash2 />
            Reverse selected
          </Button>
        </div>
      )}

      {entries.map((entry) => {
        const style = KIND_STYLES[entry.type] ?? FALLBACK_STYLE;
        const Icon = style.icon;
        const corrected = Boolean(entry.isReversal || entry.cancelled);
        return (
          <div
            key={`${entry.type}-${entry.id}`}
            className={cn(
              "flex items-center gap-3 rounded-lg border p-3",
              corrected ? "border-dashed opacity-60" : style.rowClass,
            )}
          >
            {bulkMode && (
              <Checkbox
                checked={selected.has(entry.id)}
                onCheckedChange={() => toggleSelected(entry.id)}
                aria-label={`Select ${entry.description}`}
              />
            )}
            <span
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-full",
                style.iconClass,
              )}
            >
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "truncate text-sm font-medium",
                  entry.cancelled && "line-through",
                )}
              >
                {entry.description}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDate(entry.date)}
                {entry.notes ? ` · ${entry.notes}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {entry.totalAmount != null && (
                <Badge variant="secondary" className="tabular-nums">
                  {formatMoney(entry.totalAmount)}
                </Badge>
              )}
              {entry.totalAmount == null && entry.amountLbs != null && (
                <Badge variant="secondary" className="tabular-nums">
                  {formatHoney(entry.amountLbs)}
                </Badge>
              )}
              {!bulkMode && !corrected && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={
                    entry.type === "sale"
                      ? "Cancel sale"
                      : `Reverse ${style.label.toLowerCase()} entry`
                  }
                  onClick={() => setConfirmTarget({ kind: "single", entry })}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          </div>
        );
      })}

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
                ? `Reverse ${selectedCount} entries?`
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
              The original records stay in the ledger.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep as is</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={runDelete}
            >
              {confirmTarget?.kind === "single" &&
              confirmTarget.entry.type === "sale"
                ? "Cancel sale"
                : "Reverse"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
