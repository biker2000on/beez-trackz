"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { useAccessProfile } from "@/features/access/api";
import { useSetRecommendationState } from "@/features/recommendations/api";
import {
  useCloseFeeding,
  useRefillFeeding,
} from "@/features/feedings/hooks";

import { FeedingStatusWidget } from "./feeding-status-widget";
import { FrameShortageWidget } from "./frame-shortage-widget";
import { HiveOverviewWidget } from "./hive-overview-widget";
import { HoneySummaryWidget } from "./honey-summary-widget";
import { NeedsAttentionWidget } from "./needs-attention-widget";
import { RecentInspectionsWidget } from "./recent-inspections-widget";
import { TodaysActionsWidget } from "./todays-actions-widget";
import { FIELD_VISIBLE, useFieldWork, type FieldItem } from "./hooks";

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

const REPORTS = [
  { href: "/reports", label: "Reports and analytics" },
  { href: "/recommendations", label: "All recommendations" },
];

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

/**
 * The dashboard is ordered by what the beekeeper has to do, not by what the
 * app can display: the work first (with the evidence behind each item), then
 * status, then history, then reporting.
 *
 * The two work widgets share one action-center-style keyboard order (Needs
 * attention first, then Today's field actions): arrows move a focus ring,
 * Enter opens the hive, and d/s/r resolve the row in place.
 */
export function DashboardView() {
  const router = useRouter();
  const access = useAccessProfile();
  const isAdmin = access.data?.isAdmin === true;

  const work = useFieldWork();
  const setRecState = useSetRecommendationState();
  const closeFeeding = useCloseFeeding();
  const refillFeeding = useRefillFeeding();
  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const revealFocused = React.useRef(false);

  // The keyboard order is exactly what is visible: the first five of each
  // widget, attention before today, matching the on-screen reading order.
  const visibleItems = React.useMemo(
    () => [
      ...work.attention.slice(0, FIELD_VISIBLE),
      ...work.today.slice(0, FIELD_VISIBLE),
    ],
    [work.attention, work.today],
  );
  const focusIndex = Math.max(
    0,
    Math.min(focusedIndex, visibleItems.length - 1),
  );
  const focusedId = visibleItems[focusIndex]?.id ?? null;

  const mutating =
    setRecState.isPending || closeFeeding.isPending || refillFeeding.isPending;

  const resolveItem = React.useCallback(
    async (item: FieldItem, key: "d" | "s" | "r") => {
      const where = item.hiveName ? ` on ${item.hiveName}` : "";
      try {
        if (item.kind === "recommendation" && item.recommendationId) {
          if (key === "r") return;
          await setRecState.mutateAsync({
            ids: [item.recommendationId],
            state: key === "d" ? "dismissed" : "snoozed",
          });
          toast.success(
            key === "d" ? "Recommendation dismissed" : "Snoozed for 7 days",
          );
        } else if (item.kind === "feeding" && item.feedingId) {
          if (key === "s") {
            toast.info(
              "Feeder rows clear when the feeder is refilled or closed.",
            );
            return;
          }
          if (key === "r") {
            await refillFeeding.mutateAsync({ id: item.feedingId });
            toast.success(`Feeder${where} refilled`);
            return;
          }
          await closeFeeding.mutateAsync({
            id: item.feedingId,
            reason: item.unverified ? "verified_closed" : "emptied",
          });
          toast.success(`Feeder${where} closed`);
        }
      } catch (error) {
        toast.error(
          error instanceof ApiError
            ? error.message
            : "Could not update the item",
        );
      }
    },
    [closeFeeding, refillFeeding, setRecState],
  );

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (keyboardBusy(event.target)) return;
      if (visibleItems.length === 0) return;
      const focused = visibleItems[focusIndex];

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const next = Math.max(
          0,
          Math.min(visibleItems.length - 1, focusIndex + direction),
        );
        if (next !== focusIndex) revealFocused.current = true;
        setFocusedIndex(next);
      } else if ((event.key === "Enter" || event.key === "o") && focused) {
        if (
          event.target instanceof Element &&
          event.target.closest("a, button")
        ) {
          return;
        }
        if (focused.hiveId) {
          event.preventDefault();
          router.push(`/hives/${focused.hiveId}`);
        }
      } else if (
        (event.key === "d" || event.key === "s" || event.key === "r") &&
        focused &&
        !mutating
      ) {
        event.preventDefault();
        void resolveItem(focused, event.key);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusIndex, mutating, resolveItem, router, visibleItems]);

  // Reveal the focused row after arrow movement.
  React.useEffect(() => {
    if (!revealFocused.current) return;
    revealFocused.current = false;
    if (!focusedId) return;
    const row = document.querySelector<HTMLElement>(
      `[data-field-id="${CSS.escape(focusedId)}"]`,
    );
    if (!row) return;
    row.focus({ preventScroll: true });
    const bounds = row.getBoundingClientRect();
    if (bounds.top < 16 || bounds.bottom > window.innerHeight - 16) {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [focusedId]);

  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        {visibleItems.length > 0 && (
          <p className="hidden text-[11px] text-muted-foreground md:block">
            Keyboard: <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">↑/↓</kbd> move ·{" "}
            <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">Enter</kbd> open hive ·{" "}
            <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">d</kbd> close/dismiss ·{" "}
            <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">s</kbd> snooze ·{" "}
            <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">r</kbd> refill
          </p>
        )}
      </div>

      <section className="grid gap-4 lg:grid-cols-2">
        <NeedsAttentionWidget
          items={work.attention}
          isPending={work.isPending}
          isError={work.isError}
          focusedId={focusedId}
        />
        <TodaysActionsWidget
          items={work.today}
          isPending={work.isPending}
          isError={work.isError}
          focusedId={focusedId}
        />
      </section>

      <section className="grid gap-3">
        <SectionHeading>Hive and apiary status</SectionHeading>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <HiveOverviewWidget />
          {isAdmin ? <FrameShortageWidget /> : null}
          {isAdmin ? <HoneySummaryWidget /> : null}
        </div>
      </section>

      <section className="grid gap-3">
        <SectionHeading>Feeding status</SectionHeading>
        <FeedingStatusWidget />
      </section>

      <section className="grid gap-3">
        <SectionHeading>Recent activity</SectionHeading>
        <RecentInspectionsWidget />
      </section>

      <section className="grid gap-3">
        <SectionHeading>Reporting</SectionHeading>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {REPORTS.map((report) => (
            <Link
              key={report.href}
              href={report.href}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {report.label}
              <ArrowRight className="size-3.5" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
