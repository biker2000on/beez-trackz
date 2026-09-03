"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/features/honey/format";

import { useProductionWorkbench } from "./api";
import { exact, lbs, signedLbs } from "./quantity";
import { lockoutExplanations } from "./types";
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
 * Harvest, extraction, lot, bottling and finished stock are five panels of
 * one `GET /api/v1/production/workbench` (§4.8), in the order the operator
 * walks them. Every pound and every jar on this page was read from
 * `inventory_available` / `inventory_balances` server-side; nothing is summed
 * here, and nothing is fetched per widget — the dashboard's habit of
 * assembling a screen out of four reads that can disagree about the same lot
 * is what this replaces.
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
  const bulkOnHand = data?.bulkOnHand ?? [];
  const awaiting = data?.lotsAwaitingBottling ?? [];
  const jarStock = data?.jarStock ?? [];
  const batches = data?.productBatches ?? [];

  return (
    <WorkbenchShell
      title="Production"
      description="Harvest to finished stock on one screen: open extraction sessions, bulk by lot, lots waiting on a bottling run, and the jars those runs produce. Every quantity is read from the inventory ledger."
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
      <WorkbenchPanel
        step={1}
        panelKey="open-sessions"
        title="Extraction in progress"
        description="Per-hive entries write harvest operations to the ledger."
        count={openSessions.length}
        empty="No session is open. Start one from a harvest-ready hive on Today, or with the command above."
      >
        {openSessions.map((session) => (
          <WorkbenchRow
            key={session.id}
            rowKey={session.id}
            kind="session"
            title={
              <>
                <Link
                  href={`/honey/sessions/${session.id}`}
                  className="underline-offset-4 hover:underline"
                >
                  {session.apiaryName ?? "Extraction session"}
                </Link>
                <span className="text-xs font-normal text-muted-foreground">
                  {formatDate(session.date)}
                </span>
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
                {session.trueUpDifferenceLbs !== null &&
                session.trueUpDifferenceLbs !== undefined ? (
                  <>
                    {" · trued up "}
                    {signedLbs(session.trueUpDifferenceLbs)}
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
              onRun={commands.execute}
              busy={commands.busy}
            />
          </WorkbenchRow>
        ))}
      </WorkbenchPanel>

      <WorkbenchPanel
        step={2}
        panelKey="bulk-on-hand"
        title="Bulk honey by lot"
        description="Available pounds per harvest lot, from inventory_available."
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
                  href="/honey/lots"
                  className="underline-offset-4 hover:underline"
                >
                  {lot.lotCode}
                </Link>
                {lot.varietal ? (
                  <span className="rounded-full border px-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
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
        panelKey="awaiting-bottling"
        title="Waiting on a bottling run"
        description="Bulk that has a lot and no run yet."
        count={awaiting.length}
        empty="Nothing is waiting to be bottled."
      >
        {awaiting.map((lot) => (
          <WorkbenchRow
            key={lot.lotId}
            rowKey={lot.lotId}
            kind="awaiting-bottling"
            title={lot.lotCode}
            facts={
              <p
                className="text-xs text-muted-foreground"
                data-available-lbs={exact(lot.availableLbs)}
              >
                {lbs(lot.availableLbs)} available to bottle
              </p>
            }
          >
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
        step={4}
        panelKey="jar-stock"
        title="Finished stock"
        description="The same numbers Market Day sells from."
        count={jarStock.length}
        empty="No jar stock recorded."
      >
        {jarStock.map((jar) => (
          <WorkbenchRow
            key={jar.jarSizeId}
            rowKey={jar.jarSizeId}
            kind="jar-stock"
            title={
              <>
                <Link
                  href="/honey/jars"
                  className="underline-offset-4 hover:underline"
                >
                  {jar.label}
                </Link>
                {jar.parLevel !== null && jar.available < jar.parLevel ? (
                  <Badge variant="outline" data-testid="workbench-below-par">
                    Below par
                  </Badge>
                ) : null}
              </>
            }
            facts={
              <p className="text-xs text-muted-foreground">
                {jar.available} available · {jar.onHand} on hand ·{" "}
                {jar.reserved} reserved
                {jar.parLevel !== null ? ` · par ${jar.parLevel}` : ""}
              </p>
            }
          >
            <WorkbenchCommands
              commands={jar.commands}
              where={jar.label}
              onRun={commands.execute}
              busy={commands.busy}
            />
          </WorkbenchRow>
        ))}
      </WorkbenchPanel>

      <WorkbenchPanel
        step={5}
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
            title={batch.productName}
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
    </WorkbenchShell>
  );
}
