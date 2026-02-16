import { getEquipmentStock, getEquipmentTypes, seedDefaultEquipmentTypes, getFrameSummary } from "@/actions/equipment-v2";
import { EquipmentStockCard } from "@/components/equipment/equipment-stock-card";
import { AddEquipmentTypeForm } from "@/components/equipment/add-equipment-type-form";
import { NewStockForm } from "@/components/equipment/new-stock-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function EquipmentPage() {
  // Seed defaults on first visit
  await seedDefaultEquipmentTypes();

  const [stock, types, frameSummary] = await Promise.all([
    getEquipmentStock(),
    getEquipmentTypes(),
    getFrameSummary(),
  ]);

  // Group stock by category
  const grouped = stock.reduce<Record<string, typeof stock>>((acc, s) => {
    const cat = s.typeCategory;
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(s);
    return acc;
  }, {});

  // Types that don't have stock entries yet
  const typesWithStock = new Set(stock.map(s => s.typeId));
  const typesWithoutStock = types.filter(t => !typesWithStock.has(t.id));

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Equipment Inventory</h1>

      {/* Frame Summary */}
      {(frameSummary.standalone.total > 0 || frameSummary.boxFrameCapacity > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Frame Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Standalone frames */}
            {frameSummary.standalone.total > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Standalone Frames (in stock)</p>
                <div className="grid grid-cols-4 gap-2 text-center">
                  <div>
                    <p className="text-xl font-bold text-green-600">{frameSummary.standalone.drawn}</p>
                    <p className="text-xs text-muted-foreground">Drawn</p>
                  </div>
                  <div>
                    <p className="text-xl font-bold text-blue-600">{frameSummary.standalone.fresh}</p>
                    <p className="text-xs text-muted-foreground">Fresh</p>
                  </div>
                  <div>
                    <p className="text-xl font-bold text-gray-500">{frameSummary.standalone.unspecified}</p>
                    <p className="text-xs text-muted-foreground">Unspecified</p>
                  </div>
                  <div>
                    <p className="text-xl font-bold">{frameSummary.standalone.total}</p>
                    <p className="text-xs text-muted-foreground">Total</p>
                  </div>
                </div>
              </div>
            )}

            {/* Box frame capacity */}
            {frameSummary.boxBreakdown.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Frames in Deployed Boxes</p>
                <div className="space-y-1">
                  {frameSummary.boxBreakdown.map((b) => (
                    <p key={b.boxType} className="text-xs text-muted-foreground">
                      {b.boxType}: {b.deployedBoxes} deployed x {b.framesPerBox} frames = {b.totalFrameCapacity}
                    </p>
                  ))}
                </div>
                <p className="text-sm mt-1">
                  Box frame capacity: <span className="font-bold text-amber-600">{frameSummary.boxFrameCapacity}</span>
                </p>
              </div>
            )}

            {/* Grand total */}
            <div className="border-t pt-3">
              <p className="text-sm">
                Grand Total (stock + box capacity): <span className="text-2xl font-bold">{frameSummary.grandTotal}</span>
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stock cards */}
      {Object.entries(grouped).map(([category, items]) => (
        <div key={category}>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            {category} ({items.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((s) => (
              <EquipmentStockCard key={s.id} stock={s} />
            ))}
          </div>
        </div>
      ))}

      {stock.length === 0 && (
        <p className="text-muted-foreground">No equipment stock yet. Add stock for your equipment types below.</p>
      )}

      {/* Initialize stock for types */}
      {typesWithoutStock.length > 0 && (
        <NewStockForm types={typesWithoutStock.map(t => ({ id: t.id, name: t.name, category: t.category }))} />
      )}

      {/* Add new equipment type */}
      <AddEquipmentTypeForm />
    </div>
  );
}
