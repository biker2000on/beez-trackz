import { getHives } from "@/actions/hives";
import { createEquipment } from "@/actions/equipment";
import { EquipmentForm } from "@/components/equipment/equipment-form";

export default async function NewEquipmentPage({
  searchParams,
}: {
  searchParams: Promise<{ hiveId?: string }>;
}) {
  const { hiveId } = await searchParams;
  const hives = await getHives();

  return (
    <div className="p-6">
      <EquipmentForm
        action={createEquipment}
        hives={hives.map((h) => ({
          id: h.id,
          label: `${h.positionLabel} (${h.apiaryName})`,
        }))}
        defaultHiveId={hiveId}
        title="Add Equipment"
        submitLabel="Create Equipment"
      />
    </div>
  );
}
