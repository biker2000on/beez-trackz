"use client";

/**
 * Recommendations triage, action-center style (ported from gnucash-web's
 * Financial Action Center): keyboard-first navigation (arrows + d/s/x/Enter),
 * focus retention when a card leaves the list, snooze alongside dismiss,
 * swipe gestures on touch, a Pending/All/Dismissed view in the URL, and a
 * sticky bulk bar driven by selection rather than a separate mode.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlarmClock,
  ArrowUpRight,
  Hexagon,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { useSearchParamState } from "@/lib/url-state";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import {
  PRIORITIES,
  REC_VIEWS,
  useRecommendations,
  useRunRecommendationCheck,
  useSetRecommendationState,
  type Priority,
  type RecState,
  type Recommendation,
  type RecView,
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

const VIEW_LABELS: Record<RecView, string> = {
  pending: "Pending",
  all: "All",
  dismissed: "Dismissed",
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

function isSnoozed(rec: Recommendation): boolean {
  return (
    !rec.dismissed &&
    rec.snoozedUntil != null &&
    new Date(rec.snoozedUntil).getTime() > Date.now()
  );
}

/** True while typing or while a dialog is open — keyboard triage stands down. */
function keyboardBusy(target: EventTarget | null): boolean {
  if (
    target instanceof HTMLElement &&
    (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
      target.isContentEditable)
  ) {
    return true;
  }
  return Boolean(
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    ),
  );
}

function RecommendationCard({
  recommendation,
  focused,
  selected,
  onToggle,
  onState,
  onOpenHive,
  busy,
}: {
  recommendation: Recommendation;
  focused: boolean;
  selected: boolean;
  onToggle: () => void;
  onState: (state: RecState) => void;
  onOpenHive: () => void;
  busy: boolean;
}) {
  const meta = PRIORITY_META[recommendation.priority] ?? PRIORITY_META.normal;
  const touchStart = React.useRef<number | null>(null);
  const snoozed = isSnoozed(recommendation);
  const completed = recommendation.dismissed;

  return (
    <li
      data-rec-id={recommendation.id}
      tabIndex={focused ? 0 : -1}
      className={cn(
        "flex items-start gap-3 rounded-lg border bg-card p-4 outline-none transition-colors",
        meta.rowClass,
        (completed || snoozed) && "opacity-70",
        selected && "bg-primary/5",
        focused
          ? "border-primary ring-1 ring-primary/40"
          : selected && "ring-1 ring-primary",
      )}
      onTouchStart={(event) => {
        touchStart.current = event.changedTouches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        if (touchStart.current === null || completed) return;
        const distance =
          (event.changedTouches[0]?.clientX ?? touchStart.current) -
          touchStart.current;
        touchStart.current = null;
        if (distance <= -90) onState("dismissed");
        if (distance >= 90) onState("snoozed");
      }}
    >
      <Checkbox
        checked={selected}
        aria-label={`Select recommendation: ${recommendation.message}`}
        onCheckedChange={onToggle}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm">{recommendation.message}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {recommendation.hiveName && recommendation.hiveId && (
            <Link
              href={`/hives/${recommendation.hiveId}`}
              className="flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
            >
              <Hexagon className="size-3" />
              {recommendation.hiveName}
            </Link>
          )}
          <span className="capitalize">{typeLabel(recommendation.type)}</span>
          <span>{formatDate(recommendation.createdAt)}</span>
          {snoozed && recommendation.snoozedUntil && (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <AlarmClock className="size-3" />
              Snoozed until {formatDate(recommendation.snoozedUntil)}
            </Badge>
          )}
          {completed && (
            <Badge variant="outline" className="text-muted-foreground">
              Dismissed
              {recommendation.dismissedAt
                ? ` ${formatDate(recommendation.dismissedAt)}`
                : ""}
            </Badge>
          )}
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground sm:hidden">
          Swipe right to snooze · left to dismiss
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {recommendation.hiveId && (
          <Button
            variant="outline"
            size="sm"
            className="hidden sm:inline-flex"
            onClick={onOpenHive}
          >
            <ArrowUpRight className="size-4" />
            Open hive
          </Button>
        )}
        {completed || snoozed ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Restore recommendation"
            disabled={busy}
            onClick={() => onState("open")}
          >
            <RotateCcw className="size-4" />
            Restore
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Snooze recommendation for 7 days"
              title="Snooze 7 days (s)"
              disabled={busy}
              onClick={() => onState("snoozed")}
            >
              <AlarmClock className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss recommendation"
              title="Dismiss (d)"
              disabled={busy}
              onClick={() => onState("dismissed")}
            >
              <X className="size-4" />
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

export function RecommendationsView() {
  const router = useRouter();
  const [view, setView] = useSearchParamState("view", "pending", REC_VIEWS);
  const recommendations = useRecommendations(view as RecView);
  const runCheck = useRunRecommendationCheck();
  const setState = useSetRecommendationState();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const revealFocused = React.useRef(false);

  const items = React.useMemo(
    () => recommendations.data ?? [],
    [recommendations.data],
  );

  // Focus retention: clamp at render as the list shrinks so triage flows to
  // the next card instead of resetting to the top. Selection is likewise
  // derived against the visible list, so ids that left the current view
  // (dismissed, snoozed, view switch) simply stop counting.
  const focusIndex = Math.max(0, Math.min(focusedIndex, items.length - 1));
  const visibleSelected = React.useMemo(() => {
    const visible = new Set(items.map((item) => item.id));
    return new Set([...selected].filter((id) => visible.has(id)));
  }, [items, selected]);

  const toggleSelected = React.useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const applyState = React.useCallback(
    async (ids: string[], state: RecState) => {
      if (ids.length === 0 || setState.isPending) return;
      try {
        await setState.mutateAsync({ ids, state });
        setSelected(new Set());
        const verb =
          state === "dismissed"
            ? "dismissed"
            : state === "snoozed"
              ? "snoozed for 7 days"
              : "restored";
        toast.success(
          `${ids.length} recommendation${ids.length === 1 ? "" : "s"} ${verb}`,
        );
      } catch (error) {
        toast.error(
          error instanceof ApiError
            ? error.message
            : "Could not update recommendations",
        );
      }
    },
    [setState],
  );

  const openHive = React.useCallback(
    (rec: Recommendation) => {
      if (rec.hiveId) router.push(`/hives/${rec.hiveId}`);
    },
    [router],
  );

  // Action-center keys: arrows move focus, x selects, s snoozes, d dismisses,
  // Enter opens the hive the recommendation is about.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (keyboardBusy(event.target)) return;
      const focused = items[focusIndex];

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const next = Math.max(
          0,
          Math.min(items.length - 1, focusIndex + direction),
        );
        if (next !== focusIndex) revealFocused.current = true;
        setFocusedIndex(next);
      } else if (event.key === "x" && focused) {
        event.preventDefault();
        toggleSelected(focused.id);
      } else if (event.key === "d" && focused && !focused.dismissed) {
        event.preventDefault();
        void applyState([focused.id], "dismissed");
      } else if (event.key === "s" && focused && !focused.dismissed) {
        event.preventDefault();
        void applyState([focused.id], "snoozed");
      } else if ((event.key === "Enter" || event.key === "o") && focused) {
        if (
          event.target instanceof Element &&
          event.target.closest("a, button")
        ) {
          return;
        }
        event.preventDefault();
        openHive(focused);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyState, focusIndex, items, openHive, toggleSelected]);

  // Reveal the focused card after arrow movement.
  React.useEffect(() => {
    if (!revealFocused.current) return;
    revealFocused.current = false;
    const rec = items[focusIndex];
    if (!rec) return;
    const card = document.querySelector<HTMLElement>(
      `[data-rec-id="${rec.id}"]`,
    );
    if (!card) return;
    card.focus({ preventScroll: true });
    const bounds = card.getBoundingClientRect();
    if (bounds.top < 16 || bounds.bottom > window.innerHeight - 16) {
      card.scrollIntoView({ block: "nearest" });
    }
  }, [focusIndex, items]);

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

  const allSelected =
    visibleSelected.size === items.length && items.length > 0;

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Recommendations</h1>
          <p className="text-sm text-muted-foreground">
            AI-generated suggestions from your inspection and feeding history.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={view} onValueChange={setView}>
            <TabsList>
              {REC_VIEWS.map((option) => (
                <TabsTrigger key={option} value={option}>
                  {VIEW_LABELS[option]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
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

      <p className="hidden text-right text-[11px] text-muted-foreground md:block">
        Keyboard: <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">↑/↓</kbd> move ·{" "}
        <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">x</kbd> select ·{" "}
        <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">s</kbd> snooze ·{" "}
        <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">d</kbd> dismiss ·{" "}
        <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">Enter</kbd> open hive
      </p>

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
            <CardTitle>
              {view === "dismissed" ? "Nothing dismissed" : "All clear"}
            </CardTitle>
            <CardDescription>
              {view === "dismissed"
                ? "Dismissed recommendations land here so they can be restored."
                : "No open recommendations. Run a check to analyze your hives now."}
            </CardDescription>
          </CardHeader>
          {view !== "dismissed" && (
            <CardContent className="flex justify-center pb-10">
              <Button onClick={handleRunCheck} disabled={runCheck.isPending}>
                <RefreshCw
                  className={cn(runCheck.isPending && "animate-spin")}
                />
                Run check
              </Button>
            </CardContent>
          )}
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
                    <RecommendationCard
                      key={item.id}
                      recommendation={item}
                      focused={items[focusIndex]?.id === item.id}
                      selected={visibleSelected.has(item.id)}
                      onToggle={() => toggleSelected(item.id)}
                      onState={(state) => void applyState([item.id], state)}
                      onOpenHive={() => openHive(item)}
                      busy={setState.isPending}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {visibleSelected.size > 0 && (
        <div className="sticky bottom-20 z-20 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3 shadow-lg md:bottom-4">
          <span className="text-sm font-medium">{visibleSelected.size} selected</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setSelected(
                allSelected ? new Set() : new Set(items.map((i) => i.id)),
              )
            }
          >
            {allSelected ? "Clear all" : "Select all"}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {view === "dismissed" ? (
              <Button
                size="sm"
                disabled={setState.isPending}
                onClick={() => void applyState([...visibleSelected], "open")}
              >
                <RotateCcw />
                Restore selected
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={setState.isPending}
                  onClick={() => void applyState([...visibleSelected], "snoozed")}
                >
                  <AlarmClock />
                  Snooze 7 days
                </Button>
                <Button
                  size="sm"
                  disabled={setState.isPending}
                  onClick={() => void applyState([...visibleSelected], "dismissed")}
                >
                  <X />
                  Dismiss selected
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
