import { getHives } from "@/actions/hives";
import { createHarvest } from "@/actions/honey";
import { HarvestForm } from "@/components/honey/harvest-form";

export default async function NewHarvestPage() {
  const hives = await getHives();

  return (
    <div className="p-6">
      <HarvestForm
        action={createHarvest}
        hives={hives.map((h) => ({
          id: h.id,
          label: `${h.positionLabel} (${h.apiaryName})`,
        }))}
        title="Record Harvest"
        submitLabel="Save Harvest"
      />
    </div>
  );
}
