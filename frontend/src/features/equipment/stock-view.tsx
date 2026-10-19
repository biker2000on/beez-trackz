"use client";

import * as React from "react";
import Link from "next/link";
import { PackageOpen, Plus, Wrench } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useShortcut } from "@/components/shortcuts/provider";

import { AddStockDialog } from "./add-dialogs";
import {
  useActiveDeployments,
  useEquipmentStock,
  useEquipmentTypes,
  useSeedDefaultTypes,
} from "./hooks";
import { DeploymentsGrid } from "./deployments-grid";
import { LossReportCard } from "./loss-report";
import { ReturnDeploymentDialog } from "./return-dialog";
import { StockTable } from "./stock-table";
import type { ActiveDeployment } from "./types";

/**
 * Equipment, once.
 *
 * Every quantity on this page is `GET /equipment/stock`, which the server
 * sums from the inventory ledger (`inventory_balances` for on hand, deployed,
 * damaged and retired; `inventory_available` at the home location for
 * available). The table is the one place those columns are drawn; the
 * header's status line restates its totals and nothing else does. Types and
 * bills of materials live in Setup › Equipment types.
 */
export function EquipmentStockView() {
  const stock = useEquipmentStock();
  const types = useEquipmentTypes();
  const deployments = useActiveDeployments();
  const seedDefaults = useSeedDefaultTypes();
  const [stockOpen, setStockOpen] = React.useState(false);
  const [returning, setReturning] = React.useState<ActiveDeployment | null>(
    null,
  );

  useShortcut("n", "Add stock", () => setStockOpen(true));

  const rows = stock.data ?? [];
  const onHand = rows.reduce((total, row) => total + row.totalOwned, 0);
  const deployed = rows.reduce((total, row) => total + row.deployed, 0);
  const available = rows.reduce((total, row) => total + row.available, 0);
  const shortfall = rows.reduce((total, row) => total + row.shortfall, 0);

  return (
    <div className="grid gap-6">
      <PageHeader
        subtitle="What you own, what is on hives, and what is ready to deploy."
        status={
          stock.data ? (
            <p
              data-testid="equipment-totals"
              className="text-sm text-muted-foreground tabular-nums"
            >
              {onHand} on hand · {deployed} deployed · {available} available
              {shortfall > 0 ? ` · ${shortfall} short of target` : ""}
            </p>
          ) : null
        }
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/equipment/types">
                <Wrench />
                Equipment types
              </Link>
            </Button>
            <Button onClick={() => setStockOpen(true)}>
              <Plus />
              Add stock
            </Button>
          </>
        }
      />

      {stock.isPending ? (
        <div className="grid gap-3">
          <Skeleton className="h-10 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </div>
      ) : stock.isError ? (
        <LoadError onRetry={() => stock.refetch()} />
      ) : (
        <>
          {(types.data?.length ?? 0) === 0 && (
            <div className="flex flex-col gap-4 rounded-lg border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-semibold">Start with standard equipment</p>
                <p className="text-sm text-muted-foreground">
                  Add common boxes, frames, covers, and bottom boards in one
                  click, then count what you own.
                </p>
              </div>
              <Button
                onClick={() => seedDefaults.mutate(undefined)}
                disabled={seedDefaults.isPending}
              >
                <PackageOpen />
                {seedDefaults.isPending ? "Adding…" : "Add standard types"}
              </Button>
            </div>
          )}

          {rows.length > 0 && onHand === 0 && deployed === 0 ? (
            <p
              data-testid="equipment-zero"
              className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground"
            >
              Nothing counted yet. Add stock when equipment arrives, or use
              Physical count to enter what you already own; deploying to a
              hive moves it from Available to Deployed.
            </p>
          ) : null}

          <StockTable rows={rows} />

          <section className="grid gap-2" aria-labelledby="equipment-deployments">
            <div className="grid gap-0.5">
              <h2 id="equipment-deployments" className="text-sm font-semibold">
                On hives
              </h2>
              <p className="text-sm text-muted-foreground">
                Equipment currently out on a hive. Returns can be partial.
              </p>
            </div>
            {deployments.isPending ? (
              <div className="grid gap-2">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
            ) : deployments.isError ? (
              <LoadError onRetry={() => deployments.refetch()} />
            ) : deployments.data.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-6 text-sm text-muted-foreground">
                Nothing is deployed. Use a row’s menu above to deploy
                equipment to a hive.
              </p>
            ) : (
              <div className="rounded-lg border">
                <DeploymentsGrid
                  deployments={deployments.data}
                  onReturn={setReturning}
                />
              </div>
            )}
          </section>

          <LossReportCard />
        </>
      )}

      <AddStockDialog open={stockOpen} onOpenChange={setStockOpen} />
      {returning && (
        <ReturnDeploymentDialog
          deployment={returning}
          open
          onOpenChange={(open) => {
            if (!open) setReturning(null);
          }}
        />
      )}
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
      <p>Could not load this equipment data.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
