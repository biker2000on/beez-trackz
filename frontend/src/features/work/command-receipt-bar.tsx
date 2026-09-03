"use client";

import { CheckCircle2, CloudOff, Loader2, TriangleAlert, Undo2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { useUndoCommand, type CommandReceipt } from "./use-work-commands";
import type { WorkCommand, WorkItem } from "./types";

/**
 * What happened to the last command, in the two states that belong to an
 * *attempt* rather than to the data: **error** and **interrupted** — a
 * mutation the service worker accepted for replay, which has neither
 * succeeded nor failed yet and must not be drawn as either.
 *
 * The undo, when one exists, is a command read back out of the projection
 * (`recommendation.restore` on the dismissed row), never a path assembled
 * here. If the row cannot be read back — offline, or someone else moved it —
 * no undo is offered, because there is nothing that can honestly be promised.
 */
export function CommandReceiptBar({
  receipt,
  onRun,
  onDismiss,
  busy,
}: {
  receipt: CommandReceipt | null;
  onRun: (item: WorkItem, command: WorkCommand) => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  const undo = useUndoCommand(receipt);

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
      data-testid="work-receipt"
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

      {undo.item && undo.command ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="work-undo"
          disabled={busy}
          onClick={() => onRun(undo.item as WorkItem, undo.command as WorkCommand)}
          className="gap-1.5"
        >
          <Undo2 className="size-3.5" aria-hidden />
          Undo
        </Button>
      ) : null}

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
