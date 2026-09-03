"use client";

import * as React from "react";
import { CheckCircle2, CloudOff, Loader2, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FreshnessMarker } from "@/features/work/freshness-marker";
import { cn } from "@/lib/utils";

import type { WorkbenchReceipt } from "./use-workbench-commands";
import type { WorkFreshness } from "./types";

/**
 * The frame both workbenches share: heading, freshness, the last command's
 * receipt, and the numbered stages of the journey the screen follows.
 *
 * Production is journey §3.2 (harvest → extraction → lot → bottling →
 * finished stock) and Sales is §3.3 (market day → orders → consignment →
 * settlement). Each is *one* screen with the source commands in it, because
 * the failure the reset is fixing is a journey that crosses four modules and
 * loses its numbers at every boundary.
 */

/**
 * What happened to the last command, in the two states that belong to an
 * attempt rather than to the data.
 *
 * There is no undo here. `features/work` offers one because the projection
 * re-reads the inverse command off the dismissed row; a bottling run has no
 * such inverse in the read model, and a client-assembled reversal would be
 * exactly the second source of truth this design removes.
 */
export function WorkbenchReceiptBar({
  receipt,
  onDismiss,
}: {
  receipt: WorkbenchReceipt | null;
  onDismiss: () => void;
}) {
  if (!receipt) return null;

  const where = receipt.where ? ` on ${receipt.where}` : "";
  const tone =
    receipt.phase === "error"
      ? "border-destructive/40 bg-destructive/5"
      : receipt.phase === "queued"
        ? "border-warning bg-warning/20"
        : "border-primary/30 bg-primary/5";

  return (
    <div
      role="status"
      data-testid="workbench-receipt"
      data-phase={receipt.phase}
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm",
        tone,
      )}
    >
      {receipt.phase === "running" ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : receipt.phase === "queued" ? (
        <CloudOff className="size-4" aria-hidden />
      ) : receipt.phase === "error" ? (
        <TriangleAlert className="size-4 text-destructive" aria-hidden />
      ) : (
        <CheckCircle2 className="size-4 text-primary" aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        {receipt.phase === "running" ? (
          <>
            {receipt.commandLabel}
            {where} — running…
          </>
        ) : receipt.phase === "queued" ? (
          <>
            <span className="font-medium">
              {receipt.commandLabel}
              {where}
            </span>{" "}
            is queued offline and will sync when you reconnect. It has not been
            applied yet.
          </>
        ) : receipt.phase === "error" ? (
          <>
            <span className="font-medium">
              {receipt.commandLabel}
              {where}
            </span>{" "}
            did not run — {receipt.message}
          </>
        ) : (
          <>
            <span className="font-medium">
              {receipt.commandLabel}
              {where}
            </span>{" "}
            applied.
          </>
        )}
      </span>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Dismiss this message"
        onClick={onDismiss}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

/** One numbered stage of the journey, with its rows. */
export function WorkbenchPanel({
  step,
  panelKey,
  title,
  description,
  badge,
  empty,
  children,
  count,
}: {
  step: number;
  panelKey: string;
  title: string;
  description: string;
  badge?: React.ReactNode;
  empty: string;
  children?: React.ReactNode;
  count: number;
}) {
  return (
    <section
      data-testid="workbench-panel"
      data-panel-key={panelKey}
      className="grid gap-2"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-baseline gap-2 text-sm font-semibold">
          <span className="rounded-full border px-1.5 text-[10px] font-mono text-muted-foreground">
            {step}
          </span>
          {title}
          {badge}
        </h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {count === 0 ? (
        <p
          data-testid="workbench-panel-empty"
          className="rounded-lg border bg-card px-3 py-4 text-sm text-muted-foreground"
        >
          {empty}
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">{children}</ul>
      )}
    </section>
  );
}

/** One lot, session, draft, location or jar size. */
export function WorkbenchRow({
  rowKey,
  kind,
  title,
  facts,
  children,
}: {
  rowKey: string;
  kind: string;
  title: React.ReactNode;
  facts: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <li
      key={rowKey}
      data-testid="workbench-row"
      data-row-kind={kind}
      className="grid gap-2 rounded-xl border bg-card p-3"
    >
      <div className="grid gap-0.5">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium leading-tight">
          {title}
        </p>
        {facts}
      </div>
      {children}
    </li>
  );
}

/**
 * The outer frame: one read model in, one screen out.
 *
 * `isPending`, `isError` and `isFetching` come from the single query. A
 * workbench that could show half of itself while another widget was still
 * loading would be a workbench assembled from more than one call.
 */
export function WorkbenchShell({
  title,
  description,
  freshness,
  asOf,
  isPending,
  isFetching,
  isError,
  onRefresh,
  receipt,
  onDismissReceipt,
  aside,
  children,
}: {
  title: string;
  description: string;
  freshness: WorkFreshness | undefined;
  asOf: string | undefined;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  onRefresh: () => void;
  receipt: WorkbenchReceipt | null;
  onDismissReceipt: () => void;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-5">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <FreshnessMarker
            freshness={freshness}
            asOf={asOf}
            isFetching={isFetching}
            onRefresh={onRefresh}
          />
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      {aside}

      <WorkbenchReceiptBar receipt={receipt} onDismiss={onDismissReceipt} />

      {isPending ? (
        <div className="grid gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : isError ? (
        <p
          data-testid="workbench-error"
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-6 text-center text-sm"
        >
          Could not load this workbench.{" "}
          <button
            type="button"
            className="font-medium text-primary underline-offset-4 hover:underline"
            onClick={onRefresh}
          >
            Try again
          </button>
        </p>
      ) : (
        children
      )}
    </div>
  );
}
