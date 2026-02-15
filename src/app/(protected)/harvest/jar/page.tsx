import { getHarvests } from "@/actions/honey";
import { createJarring } from "@/actions/honey";
import { JarringForm } from "@/components/honey/jarring-form";

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function JarPage() {
  const harvests = await getHarvests();

  return (
    <div className="p-6">
      <JarringForm
        action={createJarring}
        harvests={harvests.map((h) => ({
          id: h.id,
          label: `${formatDate(h.date)} - ${h.hiveName} (${h.calculatedHoneyWeight.toFixed(1)} lbs)`,
        }))}
        title="Add Jars to Inventory"
        submitLabel="Add Jars"
      />
    </div>
  );
}
