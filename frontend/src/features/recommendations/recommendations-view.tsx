"use client";

import * as React from "react";
import { CheckSquare, Hexagon, RefreshCw, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useShortcut } from "@/components/shortcuts/provider";

import {
  PRIORITIES,
  useBulkDismissRecommendations,
  useDismissRecommendation,
  useRecommendations,
  useRunRecommendationCheck,
  type Priority,
  type Recommendation,
} from "./api";

const PRIORITY_META: Record<
  Priority,
  { label: string; badgeClass: string; rowClass: string }
> = {
  urgent: {
    label: "Urgent",
    badgeClass:
      "border-transparent bg-destructive text-destructive-foreground",
    rowClass: "border-l-2 border-l-destructive",
  },
  high: {
    label: "High",
    badgeClass: "border-transparent bg-primary text-primary-foreground",
    rowClass: "border-l-2 border-l-primary",
  },
  normal: {
    label: "Normal",
    badgeClass:
      "border-transparent bg-accent-muted text-accent dark:bg-accent dark:text-accent-foreground",
    rowClass: "border-l-2 border-l-accent",
  },
  low: {
    label: "Low",
    badgeClass: "border-transparent bg-secondary text-secondary-foreground",
    rowClass: "border-l-2 border-l-border",
  },
};

function typeLabel(type: string): string {
  return type.replaceAll("_", " ");
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function RecommendationRow({
  recommendation,
  selectable,
  selected,
  onToggle,
}: {
  recommendation: Recommendation;
  selectable: boolean;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const dismiss = useDismissRecommendation();
  const meta = PRIORITY_META[recommendation.priority] ?? PRIORITY_META.normal;

  async function handleDismiss() {
    try {
      await dismiss.mutateAsync(recommendation.id);
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not dismiss the recommendation",
      );
    }
  }

  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-lg border bg-card p-4",
        meta.rowClass,
        selected && "bg-primary/5 ring-1 ring-primary",
      )}
    >
      {selectable && (
        <Checkbox
          checked={selected}
          aria-label={`Select recommendation: ${recommendation.message}`}
          onCheckedChange={() => onToggle(recommendation.id)}
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm">{recommendation.message}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {recommendation.hiveName && (
            <span className="flex items-center gap-1">
              <Hexagon className="size-3" />
              {recommendation.hiveName}
            </span>
          )}
          <span className="capitalize">{typeLabel(recommendation.type)}</span>
          <span>{formatDate(recommendation.createdAt)}</span>
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss recommendation"
        disabled={dismiss.isPending}
        onClick={handleDismiss}
      >
        <X />
      </Button>
    </li>
  );
}

export function RecommendationsView() {
  const recommendations = useRecommendations();
  const runCheck = useRunRecommendationCheck();
  const bulkDismiss = useBulkDismissRecommendations();
  const [bulkMode, setBulkMode] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const items = recommendations.data ?? [];

  useShortcut("b", "Toggle bulk-select recommendations", () => {
    setBulkMode((active) => {
      if (active) setSelected(new Set());
      return !active;
    });
  });
  useShortcut("x", "Select all recommendations", () => {
    if (!bulkMode) return;
    setSelected(
      selected.size === items.length
        ? new Set()
        : new Set(items.map((item) => item.id)),
    );
  });

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function dismissSelected() {
    try {
      const count = await bulkDismiss.mutateAsync(Array.from(selected));
      toast.success(`${count} recommendation${count === 1 ? "" : "s"} dismissed`);
      setSelected(new Set());
      setBulkMode(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Bulk dismiss failed",
      );
    }
  }

  async function handleRunCheck() {
    try {
      await runCheck.mutateAsync();
      toast.success("Recommendation check queued", {
        description: "New recommendations will appear in a few seconds.",
      });
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not queue the recommendation check",
      );
    }
  }

  const byPriority = PRIORITIES.map((priority) => ({
    priority,
    items: items.filter((item) => item.priority === priority),
  })).filter((tier) => tier.items.length > 0);

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Recommendations</h1>
          <p className="text-sm text-muted-foreground">
            AI-generated suggestions from your inspection and feeding history.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={bulkMode ? "secondary" : "outline"}
            onClick={() => {
              setBulkMode((active) => !active);
              setSelected(new Set());
            }}
          >
            <CheckSquare />
            {bulkMode ? "Done" : "Bulk select"}
          </Button>
          <Button
            variant="outline"
            onClick={handleRunCheck}
            disabled={runCheck.isPending}
          >
            <RefreshCw className={cn(runCheck.isPending && "animate-spin")} />
            Run check
          </Button>
        </div>
      </div>

      {recommendations.isLoading ? (
        <div className="grid gap-3">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      ) : recommendations.isError ? (
        <Card>
          <CardHeader className="items-center py-10 text-center">
            <CardTitle>Could not load recommendations</CardTitle>
            <CardDescription>
              <button
                type="button"
                className="font-medium text-primary underline-offset-4 hover:underline"
                onClick={() => recommendations.refetch()}
              >
                Try again
              </button>
            </CardDescription>
          </CardHeader>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardHeader className="items-center py-10 text-center">
            <Sparkles className="mb-2 size-10 text-primary/40" />
            <CardTitle>All clear</CardTitle>
            <CardDescription>
              No open recommendations. Run a check to analyze your hives now.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center pb-10">
            <Button onClick={handleRunCheck} disabled={runCheck.isPending}>
              <RefreshCw className={cn(runCheck.isPending && "animate-spin")} />
              Run check
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-5">
          {byPriority.map((tier) => {
            const meta = PRIORITY_META[tier.priority];
            return (
              <section key={tier.priority} className="grid gap-2">
                <div className="flex items-center gap-2">
                  <Badge className={meta.badgeClass}>{meta.label}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {tier.items.length}{" "}
                    {tier.items.length === 1 ? "item" : "items"}
                  </span>
                </div>
                <ul className="grid gap-2">
                  {tier.items.map((item) => (
                    <RecommendationRow
                      key={item.id}
                      recommendation={item}
                      selectable={bulkMode}
                      selected={selected.has(item.id)}
                      onToggle={toggleSelected}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {bulkMode && items.length > 0 && (
        <div className="sticky bottom-20 z-20 flex items-center gap-2 rounded-xl border bg-card p-3 shadow-lg md:bottom-4">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setSelected(
                selected.size === items.length
                  ? new Set()
                  : new Set(items.map((item) => item.id)),
              )
            }
          >
            {selected.size === items.length ? "Clear all" : "Select all"}
          </Button>
          <Button
            size="sm"
            className="ml-auto"
            disabled={selected.size === 0 || bulkDismiss.isPending}
            onClick={() => void dismissSelected()}
          >
            <X />
            Dismiss selected
          </Button>
        </div>
      )}
    </div>
  );
}
