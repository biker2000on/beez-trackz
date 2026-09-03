"use client";

import Link from "next/link";
import {
  AlertTriangle,
  CloudOff,
  Droplets,
  Hexagon,
  Lock,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { WORK_ROW_ATTR } from "./use-action-center";
import { useOnline } from "./use-online";
import type { WorkCommand, WorkItem, WorkSourceType } from "./types";

const SOURCE_META: Record<
  WorkSourceType,
  { label: string; icon: typeof Sparkles }
> = {
  lockout: { label: "Lockout", icon: Lock },
  recommendation: { label: "Rec", icon: Sparkles },
  feeding: { label: "Feed", icon: Droplets },
  harvest_ready: { label: "Harvest", icon: Hexagon },
};

const PRIORITY_LABEL: Record<string, string> = {
  urgent: "Urgent",
  high: "High priority",
  normal: "Normal priority",
  low: "Low priority",
};

/**
 * Why a command cannot be pressed right now, or null when it can.
 *
 * Both answers come from the server: `permitted` is this actor's answer
 * (design 2026-09-03 §4.4) and `offline` is the offline route manifest's. The
 * client never decides either — it only decides whether the *browser*
 * currently has a connection, which is the one fact the server cannot know.
 */
export function commandBlockedReason(
  command: WorkCommand,
  online: boolean,
): { kind: "forbidden" | "offline"; reason: string } | null {
  if (!command.permitted) {
    return {
      kind: "forbidden",
      reason: command.deniedReason ?? "You may not run this command.",
    };
  }
  if (!online && command.offline === "online_only") {
    return {
      kind: "offline",
      reason:
        command.offlineReason ??
        "This command needs a connection and cannot be queued.",
    };
  }
  return null;
}

function CommandButton({
  item,
  command,
  onRun,
  busy,
}: {
  item: WorkItem;
  command: WorkCommand;
  onRun: (item: WorkItem, command: WorkCommand) => void;
  busy: boolean;
}) {
  const online = useOnline();
  const blocked = commandBlockedReason(command, online);
  const willQueue = !online && !blocked && command.offline === "queueable";

  return (
    <Button
      type="button"
      size="sm"
      variant={blocked ? "outline" : "secondary"}
      disabled={Boolean(blocked) || busy}
      data-testid="work-command"
      data-command-id={command.id}
      data-blocked={blocked ? blocked.kind : undefined}
      // A disabled control must still say why it is disabled, so the reason
      // travels on the accessible name as well as in the visible list below.
      aria-label={
        blocked ? `${command.label} — ${blocked.reason}` : command.label
      }
      title={blocked ? blocked.reason : undefined}
      onClick={() => onRun(item, command)}
      className="gap-1.5"
    >
      {blocked?.kind === "offline" ? (
        <CloudOff className="size-3.5" aria-hidden />
      ) : null}
      {blocked?.kind === "forbidden" ? (
        <Lock className="size-3.5" aria-hidden />
      ) : null}
      {command.label}
      {command.keyboard ? (
        <kbd className="rounded border bg-background/70 px-1 font-mono text-[10px] leading-none">
          {command.keyboard}
        </kbd>
      ) : null}
      {willQueue ? (
        <span className="text-[10px] font-normal opacity-80">queues</span>
      ) : null}
    </Button>
  );
}

/**
 * One work item: the action, the evidence that justifies it, and the commands
 * that resolve it — each already answered for this actor and this connection.
 *
 * Nothing on this row is re-derived. Priority, ordering, grouping, permission
 * and offline disposition all arrive decided (§4.2); the row's only judgement
 * is how to draw them.
 */
export function WorkItemRow({
  item,
  focused,
  onRun,
  busy,
  hiveHref = (hiveId) => `/hives/${hiveId}`,
}: {
  item: WorkItem;
  focused: boolean;
  onRun: (item: WorkItem, command: WorkCommand) => void;
  busy: boolean;
  hiveHref?: (hiveId: string) => string;
}) {
  const online = useOnline();
  const meta = SOURCE_META[item.sourceType] ?? SOURCE_META.recommendation;
  const Icon = meta.icon;
  const urgent = item.priority === "urgent";
  const blocked = item.commands
    .map((command) => ({
      command,
      why: commandBlockedReason(command, online),
    }))
    .filter(
      (entry): entry is { command: WorkCommand; why: NonNullable<ReturnType<typeof commandBlockedReason>> } =>
        entry.why !== null,
    );

  return (
    <li
      {...{ [WORK_ROW_ATTR]: item.id }}
      data-testid="work-item"
      data-source-type={item.sourceType}
      data-priority={item.priority}
      data-status={item.status}
      tabIndex={focused ? 0 : -1}
      className={cn(
        "grid gap-2 rounded-xl border bg-card p-3 outline-none",
        urgent && "border-destructive/40",
        item.sourceType === "lockout" && "border-amber-500/40 bg-amber-500/5",
        focused && "bg-primary/5 ring-1 ring-primary/50",
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium leading-tight">
            {urgent ? (
              <span className="text-[10px] font-semibold uppercase tracking-wide text-destructive">
                Urgent
              </span>
            ) : (
              <span className="sr-only">
                {PRIORITY_LABEL[item.priority] ?? item.priority}
              </span>
            )}
            <span data-testid="work-item-title">{item.title}</span>
            {item.context.hiveId ? (
              <Link
                href={hiveHref(item.context.hiveId)}
                className="truncate text-muted-foreground underline-offset-4 hover:underline"
              >
                {item.context.hiveName ?? "hive"}
              </Link>
            ) : null}
            <span className="rounded-full border px-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {meta.label}
            </span>
            {item.status !== "open" ? (
              <span
                data-testid="work-item-status"
                className="rounded-full border px-1.5 text-[10px] uppercase tracking-wide text-muted-foreground"
              >
                {item.status}
              </span>
            ) : null}
          </p>
          {item.evidence.map((entry, index) => (
            <p
              key={`${entry.sourceType}:${entry.sourceId}:${index}`}
              className="text-xs text-muted-foreground"
            >
              {entry.text}
            </p>
          ))}
          {item.supersedes.length > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Covers {item.supersedes.length} other item
              {item.supersedes.length === 1 ? "" : "s"} on this hive.
            </p>
          ) : null}
        </div>
      </div>

      {item.commands.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {item.commands.map((command) => (
            <CommandButton
              key={command.id}
              item={item}
              command={command}
              onRun={onRun}
              busy={busy}
            />
          ))}
        </div>
      ) : null}

      {blocked.length > 0 ? (
        <ul className="grid gap-0.5" data-testid="work-command-reasons">
          {blocked.map(({ command, why }) => (
            <li
              key={command.id}
              data-testid="work-command-reason"
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
    </li>
  );
}
