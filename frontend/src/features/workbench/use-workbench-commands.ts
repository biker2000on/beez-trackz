"use client";

import * as React from "react";

import { ApiError } from "@/lib/api";

import { useRunWorkbenchCommand } from "./api";
import type { WorkCommand } from "./types";

/**
 * Running workbench commands, and the receipt of the last one.
 *
 * Four of the six states the roadmap asks for are properties of the response
 * or of the command and are rendered where they belong (online and stale on
 * the freshness marker, offline and forbidden on the command button). The
 * other two are properties of an *attempt* and live here: `error`, and
 * `queued` — a mutation the service worker accepted for replay, which is
 * neither a success nor a failure and must never be drawn as either.
 */

export type CommandPhase = "running" | "done" | "queued" | "error";

export interface WorkbenchReceipt {
  /** The lot, session, draft or location the command was run on. */
  where: string | null;
  commandId: string;
  commandLabel: string;
  phase: CommandPhase;
  mutationId?: string;
  message?: string;
}

export function useWorkbenchCommands() {
  const run = useRunWorkbenchCommand();
  // `mutate` is referentially stable across renders; the mutation object is
  // not. Closing over the stable half keeps `execute` stable.
  const { mutate } = run;
  const [receipt, setReceipt] = React.useState<WorkbenchReceipt | null>(null);

  const execute = React.useCallback(
    (command: WorkCommand, where: string | null) => {
      if (!command.permitted) {
        // The button is already disabled; this is the keyboard-and-scripting
        // path, and it must refuse for the server's stated reason rather than
        // silently doing nothing.
        setReceipt({
          where,
          commandId: command.id,
          commandLabel: command.label,
          phase: "error",
          message: command.deniedReason ?? "You may not run this command.",
        });
        return;
      }
      const base: WorkbenchReceipt = {
        where,
        commandId: command.id,
        commandLabel: command.label,
        phase: "running",
      };
      setReceipt(base);
      mutate(
        { command },
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

  return { execute, clear, receipt, busy: run.isPending };
}
