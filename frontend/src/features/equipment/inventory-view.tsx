"use client";

import * as React from "react";
import {
  Boxes,
  Frame,
  PackageOpen,
  Plus,
  RotateCcw,
  Truck,
  Warehouse,
  Wrench,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useShortcut } from "@/components/shortcuts/provider";

import { AddStockDialog, AddTypeDialog } from "./add-dialogs";
import {
  useActiveDeployments,
  useEquipmentStock,
  useEquipmentTypes,
  useFrameSummary,
  useRemoveDeployment,
  useSeedDefaultTypes,
} from "./hooks";
import { StockTable } from "./stock-table";

export function InventoryView() {
  const stock = useEquipmentStock();
  const types = useEquipmentTypes();
  const frameSummary = useFrameSummary();
  const deployments = useActiveDeployments();
  const removeDeployment = useRemoveDeployment();
  const seedDefaults = useSeedDefaultTypes();
  const [stockOpen, setStockOpen] = React.useState(false);
  const [typeOpen, setTypeOpen] = React.useState(false);

  useShortcut("n", "Add stock", () => setStockOpen(true));

  const rows = stock.data ?? [];
  const owned = rows.reduce((total, row) => total + row.totalOwned, 0);
  const inField = rows.reduce((total, row) => total + row.deployed, 0);
  const available = rows.reduce((total, row) => total + row.available, 0);

  return (
    <div className="grid gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Inventory</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            See what you own, what is in the field, and what is ready to deploy.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setTypeOpen(true)}>
            <Wrench />
            New type
          </Button>
          <Button onClick={() => setStockOpen(true)}>
            <Plus />
            Add stock
          </Button>
        </div>
      </header>

      {stock.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : stock.isError ? (
        <LoadError onRetry={() => stock.refetch()} />
      ) : (
        <>
          <section
            className="grid grid-cols-2 gap-3 xl:grid-cols-4"
            aria-label="Inventory summary"
          >
            <SummaryCard icon={Boxes} label="Owned" value={owned} />
            <SummaryCard icon={Truck} label="In field" value={inField} />
            <SummaryCard icon={Warehouse} label="In storage" value={available} />
            <SummaryCard
              icon={Frame}
              label="Frame capacity"
              value={frameSummary.data?.grandTotal ?? 0}
            />
          </section>

          {(types.data?.length ?? 0) === 0 && (
            <Card className="border-primary/30 bg-primary/5">
              <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold">Start with standard equipment</p>
                  <p className="text-sm text-muted-foreground">
                    Add common boxes, frames, covers, and bottom boards in one
                    click, then adjust the counts you own.
                  </p>
                </div>
                <Button
                  onClick={() => seedDefaults.mutate(undefined)}
                  disabled={seedDefaults.isPending}
                >
                  <PackageOpen />
                  {seedDefaults.isPending ? "Adding…" : "Add standard types"}
                </Button>
              </CardContent>
            </Card>
          )}

          <StockTable rows={rows} />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Truck className="size-4 text-primary" />
                Active deployments
              </CardTitle>
              <CardDescription>
                Equipment currently assigned to a hive.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {deployments.isPending ? (
                <div className="grid gap-2">
                  <Skeleton className="h-12" />
                  <Skeleton className="h-12" />
                </div>
              ) : deployments.isError ? (
                <LoadError onRetry={() => deployments.refetch()} />
              ) : deployments.data.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground">
                  Nothing is deployed yet. Use a stock row’s menu to send
                  equipment to a hive.
                </p>
              ) : (
                <ul className="divide-y">
                  {deployments.data.map((deployment) => (
                    <li
                      key={deployment.id}
                      className="flex min-h-14 items-center justify-between gap-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {deployment.typeName}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {deployment.hiveLabel}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant="secondary">
                          {deployment.quantity}
                        </Badge>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            removeDeployment.mutate(deployment.id)
                          }
                          disabled={removeDeployment.isPending}
                        >
                          <RotateCcw />
                          Return
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <AddStockDialog open={stockOpen} onOpenChange={setStockOpen} />
      <AddTypeDialog open={typeOpen} onOpenChange={setTypeOpen} />
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Boxes;
  label: string;
  value: number;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-5" />
        </div>
        <div>
          <p className="text-2xl font-bold tabular-nums">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
      <p>Could not load this inventory data.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
