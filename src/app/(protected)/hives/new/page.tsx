import { getApiaries } from "@/actions/apiaries";
import { createHive } from "@/actions/hives";
import { HiveForm } from "@/components/hives/hive-form";

export default async function NewHivePage({
  searchParams,
}: {
  searchParams: Promise<{ apiaryId?: string }>;
}) {
  const { apiaryId } = await searchParams;
  const apiaries = await getApiaries();

  return (
    <div className="p-6">
      <HiveForm
        action={createHive}
        apiaries={apiaries.map((a) => ({ id: a.id, name: a.name }))}
        showApiarySelect
        defaultValues={apiaryId ? { apiaryId } : undefined}
        title="New Hive"
        submitLabel="Create Hive"
      />
    </div>
  );
}
