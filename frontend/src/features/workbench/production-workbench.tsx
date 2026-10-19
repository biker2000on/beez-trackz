"use client";

import Link from "next/link";
import { ArrowRight, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFinishedStock } from "@/features/commerce/finished-stock";
import { formatDate } from "@/features/honey/format";
import { SessionStatusBadge, sessionStatus } from "@/features/honey/session-status";

import { useProductionWorkbench } from "./api";
import { exact, lbs, signedLbs } from "./quantity";
import {
  lockoutExplanations,
  type OpenSession,
  type Quantity,
  type WorkCommand,
} from "./types";
import { useWorkbenchCommands } from "./use-workbench-commands";
import { WorkbenchCommands, WorkbenchExplanations } from "./workbench-command";
import {
  WorkbenchPanel,
  WorkbenchRow,
  WorkbenchShell,
} from "./workbench-shell";

/**
 * The production workbench — journey §3.2 on one screen.
 *
 * Extraction, bulk honey by lot (with its bottling commands), finished stock
 * and product batches are the panels of one `GET /api/v1/production/workbench`
 * (§4.8), in the order the operator walks them. Each total is drawn once:
 * the lot rows carry both the lot's balance and the bottling command that
 * used to be a second list of the same lots, and finished stock is a link to
 * Stock › On hand rather than a repeat of its per-size numbers. Every pound
 * on this page was read from `inventory_available` / `inventory_balances`
 * server-side; nothing is summed here, and nothing is fetched per widget —
 * the dashboard's habit of assembling a screen out of four reads that can
 * disagree about the same lot is what this replaces.
 *
 * One exception, deliberately (Wave 6): the workbench's `jarStock` sums
 * every location, shops included, which is not what the operator can sell.
 * The Finished stock panel reads `useFinishedStock` — the ledger's home split
 * plus the Setup targets — the same read Today, Market day and Consignment
 * use, so the four pages show one number and one below-target list.
 *
 * Mutations are the source commands the read model named (start a session,
 * add entries, true up, create the lot, bottle), each already answered for
 * this actor and this offline manifest (§4.4). There is no `PUT /workbench`.
 *
 * Deep links point at the routes that exist today (`/honey/*`); wave 5 moves
 * them to `/production/*` in one change, and nothing is redirected here.
 */
export function ProductionWorkbench({ year }: { year?: number } = {}) {
  const workbench = useProductionWorkbench(year);
  const commands = useWorkbenchCommands();
  const data = workbench.data;

  const openSessions = data?.openSessions ?? [];
  // A trued-up session is finalized (routes_harvest_sessions.go: its
  // extracted weight is authoritative and entries are refused); it stays in
  // `openSessions` until it is closed, but it is not "in progress".
  const inProgress = openSessions.filter((session) => !isFinalized(session));
  const finalized = openSessions.filter(isFinalized);
  const awaiting = data?.lotsAwaitingBottling ?? [];
  // Bulk honey by lot and "available for bottling" were two lists of the same
  // lots with the same balance. One list; the bottling commands ride on it.
  const bulkOnHand = (data?.bulkOnHand ?? []).map((lot) => {
    const extra = awaiting.find((entry) => entry.lotId === lot.lotId)?.commands ?? [];
    const own = lot.commands ?? [];
    const merged = [...own, ...extra.filter((c) => !own.some((o) => o.id === c.id))];
    return { ...lot, commands: merged };
  });
  // Per-size commands ride on the workbench; the counts come from the ledger.
  const jarCommands = data?.jarStock ?? [];
  const finished = useFinishedStock();
  const stockedSizes = finished.data?.stockedAtHome ?? [];
  const jarsAtHome = finished.data?.jarsAtHome ?? 0;
  const jarsAway = finished.data?.jarsAway ?? 0;
  const belowTarget = finished.data?.belowTarget ?? [];
  const batches = data?.productBatches ?? [];

  return (
    <WorkbenchShell
      description="Extract, bottle, and follow each lot into finished stock."
      freshness={data?.freshness}
      asOf={data?.asOf}
      isPending={workbench.isPending}
      isFetching={workbench.isFetching}
      isError={workbench.isError}
      onRefresh={() => void workbench.refetch()}
      receipt={commands.receipt}
      onDismissReceipt={commands.clear}
      aside={
        <div className="grid gap-1.5" data-testid="workbench-actions">
          <WorkbenchCommands
            commands={data?.commands}
            where={null}
            onRun={commands.execute}
            busy={commands.busy}
          />
        </div>
      }
    >
      <BulkShortAlert shortLbs={data?.bulkShortLbs} />

      <WorkbenchPanel
        step={1}
        panelKey="open-sessions"
        title="Extraction in progress"
        description="Sessions still taking harvest entries."
        count={inProgress.length}
        empty={
          finalized.length > 0
            ? "No session is taking entries. The trued-up sessions below are waiting to be closed."
            : "No session is open. Start one from a harvest-ready hive on Today, or with the command above."
        }
      >
        {inProgress.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            onRun={commands.execute}
            busy={commands.busy}
          />
        ))}
      </WorkbenchPanel>

      {finalized.length > 0 ? (
        <WorkbenchPanel
          step={1}
          panelKey="finalized-sessions"
          title="Trued up, not yet closed"
          description="Extracted weight is final; close each session to finish it."
          count={finalized.length}
          empty=""
        >
          {finalized.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onRun={commands.execute}
              busy={commands.busy}
            />
          ))}
        </WorkbenchPanel>
      ) : null}

      <WorkbenchPanel
        step={2}
        panelKey="bulk-on-hand"
        title="Bulk honey by lot"
        description="What each lot still holds, and whether it can be bottled."
        count={bulkOnHand.length}
        empty="No bulk honey on hand."
      >
        {bulkOnHand.map((lot) => (
          <WorkbenchRow
            key={lot.lotId}
            rowKey={lot.lotId}
            kind="bulk-lot"
            title={
              <>
                <Link
                  href={`/production/lots/${lot.lotId}`}
                  className="underline-offset-4 hover:underline"
                >
                  {lot.lotCode}
                </Link>
                {lot.varietal ? (
                  <span className="rounded-full border px-1.5 text-xs text-muted-foreground">
                    {lot.varietal}
                  </span>
                ) : null}
                {lot.lockedOut ? (
                  <Badge variant="destructive" data-testid="workbench-lockout">
                    Locked out
                  </Badge>
                ) : null}
              </>
            }
            facts={
              <p
                className="text-xs text-muted-foreground"
                data-available-lbs={exact(lot.availableLbs)}
              >
                {lbs(lot.availableLbs)} available
              </p>
            }
          >
            {/* The lockout is stated before any command is pressed (S2). */}
            <WorkbenchExplanations explanations={lockoutExplanations(lot)} />
            <WorkbenchCommands
              commands={lot.commands}
              where={lot.lotCode}
              onRun={commands.execute}
              busy={commands.busy}
            />
          </WorkbenchRow>
        ))}
      </WorkbenchPanel>

      <WorkbenchPanel
        step={3}
        panelKey="jar-stock"
        title="Finished stock"
        description="Jars at home, counted on Stock › On hand; the same numbers Market day sells from."
        count={finished.isPending || finished.isError ? 0 : stockedSizes.length}
        empty={
          finished.isPending
            ? "Counting finished stock…"
            : finished.isError
              ? "Finished stock could not be counted. Refresh to try again."
              : "No jars at home. Bottle a lot above to start finished stock."
        }
      >
        <WorkbenchRow
          rowKey="jar-stock-summary"
          kind="jar-stock"
          title={
            <Link
              href="/stock?tab=finished"
              className="underline-offset-4 hover:underline"
            >
              {jarsAtHome} {jarsAtHome === 1 ? "jar" : "jars"} at home in{" "}
              {stockedSizes.length} {stockedSizes.length === 1 ? "size" : "sizes"}
              {jarsAway > 0 ? ` · ${jarsAway} at shops` : ""}
            </Link>
          }
          facts={
            belowTarget.length > 0 ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="workbench-below-par"
              >
                Below target:{" "}
                {belowTarget
                  .map((jar) => `${jar.label} (${jar.atHome} of target ${jar.target} jars)`)
                  .join(", ")}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Every size is at or above its target.
              </p>
            )
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href="/stock?tab=finished">
                Finished stock on hand
                <ArrowRight />
              </Link>
            </Button>
            {jarCommands.map((jar) =>
              jar.commands?.length ? (
                <WorkbenchCommands
                  key={jar.jarSizeId}
                  commands={jar.commands}
                  where={jar.label}
                  onRun={commands.execute}
                  busy={commands.busy}
                />
              ) : null,
            )}
          </div>
        </WorkbenchRow>
      </WorkbenchPanel>

      {batches.length > 0 && <WorkbenchPanel
        step={4}
        panelKey="product-batches"
        title="Product batches"
        description="Creamed honey and other made products."
        count={batches.length}
        empty="No product batches on hand."
      >
        {batches.map((batch) => (
          <WorkbenchRow
            key={batch.id}
            rowKey={batch.id}
            kind="product-batch"
            title={<Link href={`/production/products/batches/${batch.id}`} className="hover:underline">{batch.productName}</Link>}
            facts={
              <p className="text-xs text-muted-foreground">
                {batch.onHand} on hand
              </p>
            }
          >
            <WorkbenchCommands
              commands={batch.commands}
              where={batch.productName}
              onRun={commands.execute}
              busy={commands.busy}
            />
          </WorkbenchRow>
        ))}
      </WorkbenchPanel>
      }
    </WorkbenchShell>
  );
}

/** One open session: who, when, how much, and its commands. */
function SessionRow({
  session,
  onRun,
  busy,
}: {
  session: OpenSession;
  onRun: (command: WorkCommand, where: string | null) => void;
  busy: boolean;
}) {
  return (
          <WorkbenchRow
                        rowKey={session.id}
            kind="session"
            title={
              <>
                <Link
                  href={`/production/sessions/${session.id}`}
                  className="underline-offset-4 hover:underline"
                >
                  {session.apiaryName ?? "Extraction session"}
                </Link>
                <span className="text-xs font-normal text-muted-foreground">
                  {formatDate(session.date)}
                </span>
                <SessionStatusBadge
                  status={sessionStatus(session)}
                  data-testid={
                    isFinalized(session) ? "workbench-session-finalized" : undefined
                  }
                />
              </>
            }
            facts={
              <p
                className="text-xs text-muted-foreground"
                data-testid="workbench-session-facts"
                data-total-lbs={exact(session.calculatedTotalLbs)}
              >
                {session.entryCount}{" "}
                {session.entryCount === 1 ? "entry" : "entries"}
                {" · "}
                {lbs(session.calculatedTotalLbs)} calculated
                {isFinalized(session) ? (
                  <>
                    {" · trued up "}
                    {signedLbs(session.trueUpDifferenceLbs as Quantity)}
                  </>
                ) : (
                  " · not trued up yet"
                )}
              </p>
            }
          >
            <WorkbenchCommands
              commands={session.commands}
              where={session.apiaryName ?? "this session"}
              onRun={onRun}
              busy={busy}
            />
          </WorkbenchRow>
  );
}

/** Trued up: the server treats the extracted weight as final (§3.2 step 4). */
function isFinalized(session: OpenSession): boolean {
  return (
    session.trueUpDifferenceLbs !== null &&
    session.trueUpDifferenceLbs !== undefined
  );
}

/**
 * Bulk honey short of what was jarred — the warning the old honey overview
 * carried. The read model's `bulkShortLbs` is how far the bulk-honey balance
 * (the one `/honey/overview` reports) is below zero: jars recorded from honey
 * no harvest accounts for. The lot rows read `inventory_available`, which
 * never goes negative, so without this the gap would not show here. It rides
 * on the same single workbench read; nothing is fetched for it.
 */
function BulkShortAlert({ shortLbs }: { shortLbs: Quantity | null | undefined }) {
  if (shortLbs === null || shortLbs === undefined) return null;
  return (
    <div
      role="alert"
      data-testid="workbench-bulk-short"
      data-short-lbs={exact(shortLbs)}
      className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
    >
      <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Bulk honey is short of what was jarred</p>
        <p className="text-muted-foreground">
          Jars on the shelf exceed recorded harvests.{" "}
          {lbs(shortLbs)} more has been jarred than harvested.
          Record the missing harvests or write off the gap.
        </p>
      </div>
      <Button asChild size="sm" variant="outline">
        <Link href="/production/harvests">
          Record harvests
          <ArrowRight />
        </Link>
      </Button>
    </div>
  );
}
