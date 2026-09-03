"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { formatDate, formatMoney } from "@/features/honey/format";

import { useSalesWorkbench } from "./api";
import { shortfallExplanations } from "./types";
import { useWorkbenchCommands } from "./use-workbench-commands";
import { WorkbenchCommands, WorkbenchExplanations } from "./workbench-command";
import {
  WorkbenchPanel,
  WorkbenchRow,
  WorkbenchShell,
} from "./workbench-shell";

/**
 * The sales workbench — journey §3.3 on one screen.
 *
 * Market day, orders, consignment and settlement are four panels of one
 * `GET /api/v1/sales/workbench` (§4.8). The numbers are the ledger's:
 * `availableAtHome` is home-location availability — what Market Day may
 * actually sell — not a global total, which is the distinction that made a
 * stall sell jars that were already out on consignment.
 *
 * A draft's `shortfalls` are `sales.Service.CheckAvailability` surfaced as a
 * *read*, so the draft states what it is short of before anyone presses
 * anything. An explanation that only appears after the server refuses is an
 * error message, not an explanation.
 *
 * Deep links point at the routes that exist today; wave 5 rewrites them.
 */
export function SalesWorkbench({ year }: { year?: number } = {}) {
  const workbench = useSalesWorkbench(year);
  const commands = useWorkbenchCommands();
  const data = workbench.data;

  const takings = data?.todayTakings;
  const drafts = data?.drafts ?? [];
  const consignment = data?.consignment ?? [];
  const sellable = data?.sellable ?? [];

  return (
    <WorkbenchShell
      title="Sales"
      description="Today's takings, drafts with what they are short of, consignment stock still out, and settlements due — one read, with the source command beside each."
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
        panelKey="today-takings"
        title="Today"
        description="What has already been rung up."
        count={takings ? 1 : 0}
        empty="Nothing sold yet today."
      >
        {takings ? (
          <WorkbenchRow
            rowKey="takings"
            kind="takings"
            title={
              <>
                <span data-testid="workbench-takings">
                  {formatMoney(takings.revenueCents / 100)}
                </span>
                <Badge variant="outline">
                  {takings.salesCount}{" "}
                  {takings.salesCount === 1 ? "sale" : "sales"}
                </Badge>
              </>
            }
            facts={
              <p className="text-xs text-muted-foreground">
                Ring up the next one on{" "}
                <Link
                  href="/sales/market-day"
                  className="underline-offset-4 hover:underline"
                >
                  Market day
                </Link>
                , the offline-critical screen.
              </p>
            }
          />
        ) : null}
      </WorkbenchPanel>

      <WorkbenchPanel
        step={2}
        panelKey="drafts"
        title="Drafts"
        description="Orders not yet applied, with what they are short of."
        count={drafts.length}
        empty="No draft orders."
      >
        {drafts.map((draft) => {
          const explanations = shortfallExplanations(draft);
          return (
            <WorkbenchRow
              key={draft.saleId}
              rowKey={draft.saleId}
              kind="draft"
              title={
                <>
                  <Link
                    href={`/sales/${draft.saleId}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {draft.customerName ?? "Walk-in"}
                  </Link>
                  {explanations.length > 0 ? (
                    <Badge
                      variant="destructive"
                      data-testid="workbench-shortfall-badge"
                    >
                      Short {explanations.length}
                    </Badge>
                  ) : null}
                </>
              }
              facts={
                <p className="text-xs text-muted-foreground">
                  {draft.lineCount} {draft.lineCount === 1 ? "line" : "lines"}
                </p>
              }
            >
              {/* Shortfalls first, then the command they would refuse. */}
              <WorkbenchExplanations explanations={explanations} />
              <WorkbenchCommands
                commands={draft.commands}
                where={draft.customerName ?? "this draft"}
                onRun={commands.execute}
                busy={commands.busy}
              />
            </WorkbenchRow>
          );
        })}
      </WorkbenchPanel>

      <WorkbenchPanel
        step={3}
        panelKey="consignment"
        title="Consignment"
        description="Stock out on location, and what is due to settle."
        count={consignment.length}
        empty="Nothing is out on consignment."
      >
        {consignment.map((location) => (
          <WorkbenchRow
            key={location.locationId}
            rowKey={location.locationId}
            kind="consignment"
            title={
              <>
                <Link
                  href={`/sales/consignment/${location.locationId}`}
                  className="underline-offset-4 hover:underline"
                >
                  {location.name}
                </Link>
                {location.settlementDueAt ? (
                  <Badge variant="outline" data-testid="workbench-settlement-due">
                    Due {formatDate(location.settlementDueAt)}
                  </Badge>
                ) : null}
              </>
            }
            facts={
              <p className="text-xs text-muted-foreground">
                {location.unitsOut} out
                {location.lastSettledAt
                  ? ` · last settled ${formatDate(location.lastSettledAt)}`
                  : " · never settled"}
              </p>
            }
          >
            <WorkbenchCommands
              commands={location.commands}
              where={location.name}
              onRun={commands.execute}
              busy={commands.busy}
            />
          </WorkbenchRow>
        ))}
      </WorkbenchPanel>

      <WorkbenchPanel
        step={4}
        panelKey="sellable"
        title="Sellable at home"
        description="What Market Day may actually sell — home availability, not the global total."
        count={sellable.length}
        empty="Nothing is available at the home location."
      >
        {sellable.map((item) => (
          <WorkbenchRow
            key={item.itemId}
            rowKey={item.itemId}
            kind="sellable"
            title={
              <>
                {item.label}
                {item.lotCode ? (
                  <span className="rounded-full border px-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {item.lotCode}
                  </span>
                ) : null}
              </>
            }
            facts={
              <p
                className="text-xs text-muted-foreground"
                data-available-at-home={String(item.availableAtHome)}
              >
                {item.availableAtHome} available at home
              </p>
            }
          >
            <WorkbenchCommands
              commands={item.commands}
              where={item.label}
              onRun={commands.execute}
              busy={commands.busy}
            />
          </WorkbenchRow>
        ))}
      </WorkbenchPanel>
    </WorkbenchShell>
  );
}
