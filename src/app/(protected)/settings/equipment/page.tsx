import { getEquipmentStock, getEquipmentTypes, seedDefaultEquipmentTypes } from "@/actions/equipment-v2";
import { EquipmentStockCard } from "@/components/equipment/equipment-stock-card";
import { AddEquipmentTypeForm } from "@/components/equipment/add-equipment-type-form";
import { NewStockForm } from "@/components/equipment/new-stock-form";

export default async function EquipmentPage() {
  // Seed defaults on first visit
  await seedDefaultEquipmentTypes();

  const [stock, types] = await Promise.all([
    getEquipmentStock(),
    getEquipmentTypes(),
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
        <NewStockForm types={typesWithoutStock.map(t => ({ id: t.id, name: t.name }))} />
      )}

      {/* Add new equipment type */}
      <AddEquipmentTypeForm />
    </div>
  );
}
