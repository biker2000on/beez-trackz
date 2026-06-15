import {
  getEquipmentStock,
  getEquipmentTypes,
  seedDefaultEquipmentTypes,
  getFrameSummary,
  getActiveDeployments,
} from "@/actions/equipment-v2";
import { getHives } from "@/actions/hives";
import { InventoryTable } from "@/components/equipment/inventory-table";
import {
  AddEquipmentTypeDialog,
  NewStockDialog,
} from "@/components/equipment/equipment-management-dialogs";
import { Card, CardContent } from "@/components/ui/card";

export default async function InventoryPage() {
  // Seed defaults on first visit
  await seedDefaultEquipmentTypes();

  const [stock, types, frameSummary, deployments, hives] = await Promise.all([
    getEquipmentStock(),
    getEquipmentTypes(),
    getFrameSummary(),
    getActiveDeployments(),
    getHives(),
  ]);

  const typesWithStock = new Set(stock.map((s) => s.typeId));
  const typesWithoutStock = types.filter((t) => !typesWithStock.has(t.id));

  const totalOwned = stock.reduce((s, r) => s + r.totalOwned, 0);
  const totalDeployed = stock.reduce((s, r) => s + r.deployed, 0);

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold">Equipment Inventory</h1>
        <div className="flex flex-wrap gap-2">
          <NewStockDialog
            types={typesWithoutStock.map((t) => ({
              id: t.id,
              name: t.name,
              category: t.category,
            }))}
          />
          <AddEquipmentTypeDialog />
        </div>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Items owned" value={String(totalOwned)} />
        <StatCard label="In the field" value={String(totalDeployed)} />
        <StatCard label="In storage" value={String(totalOwned - totalDeployed)} />
        <StatCard
          label="Spare frames"
          value={String(frameSummary.standalone.total)}
          sub={`${frameSummary.standalone.drawn} drawn · ${frameSummary.standalone.fresh} fresh`}
        />
      </div>

      {stock.length === 0 ? (
        <p className="text-muted-foreground text-sm py-4">
          No equipment stock yet. Add stock for your equipment types below, or
          create a new type for anything you own.
        </p>
      ) : (
        <InventoryTable
          stock={stock}
          deployments={deployments}
          hives={hives
            .filter((h) => h.status === "active")
            .map((h) => ({
              id: h.id,
              label: `${h.positionLabel}${h.apiaryName ? ` (${h.apiaryName})` : ""}`,
            }))}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="text-xl md:text-2xl font-bold tabular-nums mt-0.5">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}
