import { notFound } from "next/navigation";
import { getHive } from "@/actions/hives";
import { getApiaries } from "@/actions/apiaries";
import { createSplit } from "@/actions/hive-splits";
import { SplitHiveForm } from "@/components/hives/split-hive-form";

export default async function SplitHivePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const hive = await getHive(id);
  if (!hive) notFound();

  // Get all apiaries for the select
  const apiaries = await getApiaries();

  return (
    <div className="p-6">
      <SplitHiveForm
        action={createSplit}
        parentHiveId={id}
        apiaryId={hive.apiaryId}
        apiaries={apiaries.map(a => ({ id: a.id, name: a.name }))}
      />
    </div>
  );
}
