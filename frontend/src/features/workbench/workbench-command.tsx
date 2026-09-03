"use client";

import { AlertTriangle, CloudOff, Info, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { commandBlockedReason } from "@/features/work/work-item-row";
import { useOnline } from "@/features/work/use-online";

import type { Explanation, WorkCommand } from "./types";

/**
 * Explanations, then commands, then refusals — in that DOM order, always.
 *
 * The read model already carries the facts that would make a command fail:
 * a locked-out lot (S2) and a draft's shortfalls
 * (`sales.Service.CheckAvailability` surfaced as a read, §4.8). Rendering
 * them only *after* the server refuses turns a knowable fact into an error
 * message; wave 4's acceptance is that the explanation is on screen before
 * anyone presses anything.
 */
export function WorkbenchExplanations({
  explanations,
}: {
  explanations: Explanation[];
}) {
  if (explanations.length === 0) return null;
  return (
    <ul className="grid gap-0.5">
      {explanations.map((explanation, index) => (
        <li
          key={`${explanation.kind}:${index}`}
          data-testid="workbench-explanation"
          data-kind={explanation.kind}
          className="flex items-start gap-1.5 text-[11px] text-muted-foreground"
        >
          {explanation.kind === "lockout" ? (
            <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
          ) : (
            <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
          )}
          <span>{explanation.text}</span>
        </li>
      ))}
    </ul>
  );
}

function CommandButton({
  command,
  where,
  onRun,
  busy,
}: {
  command: WorkCommand;
  where: string | null;
  onRun: (command: WorkCommand, where: string | null) => void;
  busy: boolean;
}) {
  const online = useOnline();
  // Whether a command may be pressed is the server's answer (`permitted`)
  // and the offline manifest's (`offline`), joined with the one fact the
  // server cannot know: whether this browser currently has a connection.
  // The rule is imported from the field slice so the two surfaces cannot
  // drift into two answers.
  const blocked = commandBlockedReason(command, online);
  const willQueue = !online && !blocked && command.offline === "queueable";

  return (
    <Button
      type="button"
      size="sm"
      variant={blocked ? "outline" : "secondary"}
      disabled={Boolean(blocked) || busy}
      data-testid="workbench-command"
      data-command-id={command.id}
      data-blocked={blocked ? blocked.kind : undefined}
      aria-label={blocked ? `${command.label} — ${blocked.reason}` : command.label}
      title={blocked ? blocked.reason : undefined}
      onClick={() => onRun(command, where)}
      className="gap-1.5"
    >
      {blocked?.kind === "offline" ? (
        <CloudOff className="size-3.5" aria-hidden />
      ) : null}
      {blocked?.kind === "forbidden" ? (
        <Lock className="size-3.5" aria-hidden />
      ) : null}
      {command.label}
      {willQueue ? (
        <span className="text-[10px] font-normal opacity-80">queues</span>
      ) : null}
    </Button>
  );
}

/**
 * A row's commands and, beneath them, why any of them cannot be pressed.
 *
 * A disabled control that does not say why is indistinguishable from a broken
 * one, so the reason is visible text as well as the accessible name — the
 * same contract `WorkItemRow` holds on Today.
 */
export function WorkbenchCommands({
  commands,
  where,
  onRun,
  busy,
}: {
  commands: WorkCommand[] | undefined;
  where: string | null;
  onRun: (command: WorkCommand, where: string | null) => void;
  busy: boolean;
}) {
  const online = useOnline();
  const list = commands ?? [];
  if (list.length === 0) return null;

  const blocked = list
    .map((command) => ({ command, why: commandBlockedReason(command, online) }))
    .filter(
      (
        entry,
      ): entry is {
        command: WorkCommand;
        why: NonNullable<ReturnType<typeof commandBlockedReason>>;
      } => entry.why !== null,
    );

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {list.map((command) => (
          <CommandButton
            key={command.id}
            command={command}
            where={where}
            onRun={onRun}
            busy={busy}
          />
        ))}
      </div>
      {blocked.length > 0 ? (
        <ul className="grid gap-0.5">
          {blocked.map(({ command, why }) => (
            <li
              key={command.id}
              data-testid="workbench-command-reason"
              data-command-id={command.id}
              data-blocked={why.kind}
              className="flex items-start gap-1.5 text-[11px] text-muted-foreground"
            >
              {why.kind === "forbidden" ? (
                <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
              ) : (
                <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
              )}
              <span>
                <span className="font-medium">{command.label}:</span> {why.reason}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
