import { notFound } from "next/navigation";
import { getHive } from "@/actions/hives";
import { createInspection } from "@/actions/inspections";
import { InspectionForm } from "@/components/inspections/inspection-form";

export default async function NewInspectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const hive = await getHive(id);

  if (!hive) {
    notFound();
  }

  return (
    <div className="p-6">
      <InspectionForm
        action={createInspection}
        hiveId={id}
        title={`New Inspection - ${hive.positionLabel}`}
        submitLabel="Record Inspection"
      />
    </div>
  );
}
