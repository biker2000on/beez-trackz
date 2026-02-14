import { notFound } from "next/navigation";
import { getHive, updateHive } from "@/actions/hives";
import { HiveForm } from "@/components/hives/hive-form";

export default async function EditHivePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const hive = await getHive(id);

  if (!hive) {
    notFound();
  }

  const updateWithId = updateHive.bind(null, id);

  return (
    <div className="p-6">
      <HiveForm
        action={updateWithId}
        defaultValues={hive}
        title="Edit Hive"
        submitLabel="Save Changes"
      />
    </div>
  );
}
