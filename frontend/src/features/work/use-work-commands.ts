"use client";

import * as React from "react";

import { ApiError } from "@/lib/api";

import { useRunWorkCommand, useWorkToday } from "./api";
import { todayItems, type WorkCommand, type WorkItem } from "./types";

/**
 * Running commands, and the receipt of the last one.
 *
 * The roadmap asks for six visibly distinct states. Four are properties of
 * the response or the command and are rendered where they belong (online and
 * stale on the freshness marker, offline and forbidden on the command
 * button). The last two are properties of an *attempt*, and they live here:
 * `error` and `interrupted` — a mutation the service worker accepted for
 * replay, which is neither a success nor a failure and must never be drawn
 * as either.
 */

export type CommandPhase = "running" | "done" | "queued" | "error";

export interface CommandReceipt {
  itemId: string;
  itemTitle: string;
  /** The hive or yard the work was on, for a receipt the operator can read. */
  where: string | null;
  sourceType: WorkItem["sourceType"];
  sourceId: string;
  commandId: string;
  commandLabel: string;
  phase: CommandPhase;
  /** Set when the service worker queued the mutation for replay. */
  mutationId?: string;
  message?: string;
}

function whereOf(item: WorkItem): string | null {
  return item.context.hiveName ?? item.context.apiaryName ?? null;
}

/**
 * The commands whose effect the operator can take back. The inverse is never
 * constructed here — only *looked up* in a later projection read (see
 * `useUndoCommand`), because a client-built path is exactly the kind of
 * second source of truth this design removes.
 */
const REVERSIBLE: Record<string, string> = {
  "recommendation.dismiss": "recommendation.restore",
  "recommendation.snooze": "recommendation.restore",
};

export function useWorkCommands() {
  const run = useRunWorkCommand();
  // `mutate` is referentially stable across renders; the mutation object is
  // not. Closing over the stable half keeps `execute` stable, which keeps the
  // action center's key listener from re-subscribing on every render.
  const { mutate } = run;
  const [receipt, setReceipt] = React.useState<CommandReceipt | null>(null);

  const execute = React.useCallback(
    (item: WorkItem, command: WorkCommand) => {
      if (!command.permitted) {
        setReceipt({
          itemId: item.id,
          itemTitle: item.title,
          where: whereOf(item),
          sourceType: item.sourceType,
          sourceId: item.sourceId,
          commandId: command.id,
          commandLabel: command.label,
          phase: "error",
          message:
            command.deniedReason ?? "You may not run this command.",
        });
        return;
      }
      const base: CommandReceipt = {
        itemId: item.id,
        itemTitle: item.title,
        where: whereOf(item),
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        commandId: command.id,
        commandLabel: command.label,
        phase: "running",
      };
      setReceipt(base);
      mutate(
        { item, command },
        {
          onSuccess: (outcome) =>
            setReceipt({
              ...base,
              phase: outcome.queued ? "queued" : "done",
              mutationId: outcome.mutationId,
            }),
          onError: (error) =>
            setReceipt({
              ...base,
              phase: "error",
              message:
                error instanceof ApiError
                  ? error.message
                  : "Could not run this command.",
            }),
        },
      );
    },
    [mutate],
  );

  const clear = React.useCallback(() => setReceipt(null), []);

  return {
    execute,
    clear,
    receipt,
    /** True while a command is in flight — the keyboard stands down. */
    busy: run.isPending,
  };
}

/**
 * The command that undoes a receipt, read back from the projection rather
 * than assembled in the client.
 *
 * `recommendation.restore` is emitted on dismissed and snoozed rows, so the
 * same endpoint under a different filter — the design's "three filters over
 * one response shape" — is where the undo lives. If the row is not there
 * (someone else changed it, or the command was queued offline and has not
 * replayed) there is no undo to offer, and none is shown.
 */
export function useUndoCommand(receipt: CommandReceipt | null): {
  item: WorkItem | null;
  command: WorkCommand | null;
} {
  const reversibleTo =
    receipt && receipt.phase === "done"
      ? REVERSIBLE[receipt.commandId]
      : undefined;

  const triage = useWorkToday(
    {
      sourceType: ["recommendation"],
      status: ["snoozed", "dismissed"],
    },
    { enabled: Boolean(reversibleTo) },
  );

  if (!receipt || !reversibleTo) return { item: null, command: null };
  const item = todayItems(triage.data).find(
    (candidate) =>
      candidate.sourceType === receipt.sourceType &&
      candidate.sourceId === receipt.sourceId,
  );
  if (!item) return { item: null, command: null };
  const command =
    item.commands.find((candidate) => candidate.id === reversibleTo) ?? null;
  return { item, command };
}
