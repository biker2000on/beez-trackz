"use client";

/**
 * Honey hub (/harvest): stat strip, quick actions with keyboard shortcuts
 * (j/s/u/l/v/a), and the Activity / Jars / Harvests / Sales tabs.
 */

import * as React from "react";
import {
  DollarSign,
  Droplets,
  Gift,
  Package,
  SlidersHorizontal,
  TriangleAlert,
  Utensils,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useShortcut } from "@/components/shortcuts/provider";

import { ActivityTab } from "./activity-tab";
import { LotsTab } from "@/features/commerce/lots-tab";
import { BusinessTab } from "@/features/commerce/business-tab";
import { MarketDayTab } from "@/features/commerce/market-day-tab";
import { formatLbs, formatMoney } from "./format";
import { HarvestsTab } from "./harvests-tab";
import { useHoneyOverview, useJarInventory } from "./hooks";
import { JarsTab } from "./jars-tab";
import {
  AdjustJarsDialog,
  BulkMovementDialog,
  GiveAwayDialog,
  JarHoneyDialog,
} from "./movement-dialogs";
import { RecordSaleDialog } from "./record-sale-dialog";
import { SalesTab } from "./sales-tab";

type QuickAction = "jar" | "sale" | "use" | "loss" | "give" | "adjust";

const QUICK_ACTIONS: {
  action: QuickAction;
  label: string;
  keyHint: string;
  icon: LucideIcon;
}[] = [
  { action: "jar", label: "Jar honey", keyHint: "j", icon: Package },
  { action: "sale", label: "Record sale", keyHint: "s", icon: DollarSign },
  { action: "use", label: "Bulk use", keyHint: "u", icon: Utensils },
  { action: "loss", label: "Loss", keyHint: "l", icon: TriangleAlert },
  { action: "give", label: "Give away", keyHint: "v", icon: Gift },
  { action: "adjust", label: "Adjust jars", keyHint: "a", icon: SlidersHorizontal },
];

export function HoneyHub() {
  const overview = useHoneyOverview();
  const inventory = useJarInventory();
  const [dialog, setDialog] = React.useState<QuickAction | null>(null);

  useShortcut("j", "Jar honey", () => setDialog("jar"));
  useShortcut("s", "Record a sale", () => setDialog("sale"));
  useShortcut("u", "Use bulk honey", () => setDialog("use"));
  useShortcut("l", "Record a loss", () => setDialog("loss"));
  useShortcut("v", "Give away jars", () => setDialog("give"));
  useShortcut("a", "Adjust jar counts", () => setDialog("adjust"));

  const data = overview.data;
  const jarsOnHand = data?.inventory.reduce((sum, row) => sum + row.onHand, 0);
  const inventoryRows = inventory.data ?? [];

  function closeDialog(open: boolean) {
    if (!open) setDialog(null);
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Honey</h1>
        <div className="flex flex-wrap gap-2">
          {QUICK_ACTIONS.map(({ action, label, keyHint, icon: Icon }) => (
            <Button
              key={action}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDialog(action)}
            >
              <Icon />
              {label}
              <kbd className="rounded border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                {keyHint}
              </kbd>
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={Droplets}
          label="Bulk on hand"
          value={data ? formatLbs(data.bulkOnHandLbs) : undefined}
          sub={data ? `${formatLbs(data.totalHarvestedLbs)} harvested` : undefined}
          loading={overview.isPending}
        />
        <StatCard
          icon={Package}
          label="Jars on hand"
          value={jarsOnHand != null ? String(jarsOnHand) : undefined}
          sub={
            data
              ? data.inventory
                  .filter((row) => row.onHand > 0)
                  .map((row) => `${row.onHand} ${row.label}`)
                  .join(" · ") || "None jarred"
              : undefined
          }
          loading={overview.isPending}
        />
        <StatCard
          icon={DollarSign}
          label="Revenue"
          value={data ? formatMoney(data.totalRevenue) : undefined}
          sub={data ? `${data.jarsSold} jars sold` : undefined}
          loading={overview.isPending}
        />
        <StatCard
          icon={TriangleAlert}
          label="Used + losses"
          value={data ? formatLbs(data.bulkUsedLbs + data.lossLbs) : undefined}
          sub={
            data
              ? `${formatLbs(data.bulkUsedLbs)} used · ${formatLbs(data.lossLbs)} lost`
              : undefined
          }
          loading={overview.isPending}
        />
      </div>

      <Tabs defaultValue="activity">
        <TabsList className="flex w-full flex-wrap justify-start">
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="jars">Jars</TabsTrigger>
          <TabsTrigger value="harvests">Harvests</TabsTrigger>
          <TabsTrigger value="sales">Sales</TabsTrigger>
          <TabsTrigger value="lots">Lots & QR</TabsTrigger>
          <TabsTrigger value="market">Market day</TabsTrigger>
          <TabsTrigger value="business">Business</TabsTrigger>
        </TabsList>
        <TabsContent value="activity">
          <ActivityTab />
        </TabsContent>
        <TabsContent value="jars">
          <JarsTab />
        </TabsContent>
        <TabsContent value="harvests">
          <HarvestsTab />
        </TabsContent>
        <TabsContent value="sales">
          <SalesTab />
        </TabsContent>
        <TabsContent value="lots">
          <LotsTab />
        </TabsContent>
        <TabsContent value="market">
          <MarketDayTab />
        </TabsContent>
        <TabsContent value="business">
          <BusinessTab />
        </TabsContent>
      </Tabs>

      <JarHoneyDialog
        open={dialog === "jar"}
        onOpenChange={closeDialog}
        inventory={inventoryRows}
      />
      <RecordSaleDialog
        open={dialog === "sale"}
        onOpenChange={closeDialog}
        inventory={inventoryRows}
      />
      <BulkMovementDialog
        open={dialog === "use"}
        onOpenChange={closeDialog}
        kind="bulk_use"
      />
      <BulkMovementDialog
        open={dialog === "loss"}
        onOpenChange={closeDialog}
        kind="loss"
      />
      <GiveAwayDialog
        open={dialog === "give"}
        onOpenChange={closeDialog}
        inventory={inventoryRows}
      />
      <AdjustJarsDialog
        open={dialog === "adjust"}
        onOpenChange={closeDialog}
        inventory={inventoryRows}
      />
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  loading,
}: {
  icon: LucideIcon;
  label: string;
  value?: string;
  sub?: string;
  loading: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon className="size-4" />
          <span className="text-xs font-medium uppercase tracking-wide">
            {label}
          </span>
        </div>
        {loading || value == null ? (
          <Skeleton className="mt-2 h-7 w-24" />
        ) : (
          <p className="mt-1 truncate text-2xl font-bold tabular-nums">
            {value}
          </p>
        )}
        {sub != null && !loading && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</p>
        )}
      </CardContent>
    </Card>
  );
}
