"use client";

import { Badge } from "@/components/ui/badge";
import type { WorkCommand } from "@/features/work/types";

/**
 * One status for an extraction session, wherever it is drawn.
 *
 * Today, In progress, Harvests and the session record used to each pick a
 * word of their own for the same July session ("extraction remains open",
 * "Trued up · close to finish", "Finalized"). The server exposes the same
 * three facts on every read model — `closedAt`, `totalExtractedWeight`
 * (harvest-sessions) and `trueUpDifferenceLbs` (the workbench) — and the
 * status is a function of those, so it is computed here once and rendered
 * by one component.
 *
 *   Taking entries → Trued up → Closed
 *
 * Trued up: the operator recorded the extracted weight, which the server
 * treats as authoritative (routes_harvest_sessions.go: further entries are
 * refused). Closed: `POST /harvest-sessions/{id}/close` was called and the
 * session leaves active work. `closedAt` is the only closed signal the API
 * carries — nothing else on the session (date, season, true-up) makes it
 * closed — so a trued-up session stays "Trued up" until the operator runs
 * Close session, which `closeSessionCommand` offers wherever a trued-up
 * session is drawn.
 */
export type SessionStatus = "taking_entries" | "trued_up" | "closed";

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  taking_entries: "Taking entries",
  trued_up: "Trued up",
  closed: "Closed",
};

export const SESSION_STATUS_ORDER: SessionStatus[] = [
  "taking_entries",
  "trued_up",
  "closed",
];

/** A session with a recorded extracted weight is trued up: the true-up is
 * authoritative and new entries would change nothing. */
export function sessionFinalized(totalExtractedWeight: number | null | undefined): boolean {
  return totalExtractedWeight != null && totalExtractedWeight !== 0;
}

export function sessionStatus(session: {
  closedAt?: string | null;
  totalExtractedWeight?: number | null;
  /** The workbench's signal: null until the session is trued up. */
  trueUpDifferenceLbs?: string | number | null;
}): SessionStatus {
  if (session.closedAt) return "closed";
  if (
    (session.trueUpDifferenceLbs !== null && session.trueUpDifferenceLbs !== undefined) ||
    sessionFinalized(session.totalExtractedWeight)
  ) {
    return "trued_up";
  }
  return "taking_entries";
}

/**
 * The Close session command, in the shape the workbench runs commands in, so
 * the receipt, the invalidations and the offline refusal are the shared ones.
 * The production workbench's read model does not carry it (its session
 * commands are only `harvest.add_entry`), so it is built here from the
 * route that exists: `POST /harvest-sessions/{id}/close`.
 */
export function closeSessionCommand(sessionId: string): WorkCommand {
  return {
    id: "harvest.close",
    label: "Close session",
    method: "POST",
    path: `/api/v1/harvest-sessions/${sessionId}/close`,
    bodyTemplate: {},
    permitted: true,
    deniedReason: null,
    offline: "online_only",
    offlineReason: "Closing a session needs the server.",
    idempotencyKeyTemplate: `harvest.close:${sessionId}:{clientMutationId}`,
    keyboard: "",
  };
}

const VARIANTS: Record<SessionStatus, "accent" | "outline" | "secondary"> = {
  taking_entries: "accent",
  trued_up: "outline",
  closed: "secondary",
};

export function SessionStatusBadge({
  status,
  ...rest
}: { status: SessionStatus } & Record<`data-${string}`, string | undefined>) {
  return (
    <Badge variant={VARIANTS[status]} data-session-status={status} {...rest}>
      {SESSION_STATUS_LABELS[status]}
    </Badge>
  );
}
