import { getApiaries } from "@/actions/apiaries";
import { createHarvestSession } from "@/actions/harvest-sessions";
import { HarvestSessionForm } from "@/components/honey/harvest-session-form";

export default async function NewHarvestSessionPage() {
  const apiaries = await getApiaries();

  return (
    <div className="container max-w-2xl py-8">
      <h1 className="mb-6 text-3xl font-bold">New Harvest Session</h1>
      <HarvestSessionForm
        action={createHarvestSession}
        apiaries={apiaries.map((a) => ({ id: a.id, name: a.name }))}
      />
    </div>
  );
}
