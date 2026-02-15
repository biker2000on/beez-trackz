import { notFound } from "next/navigation";
import { getHive } from "@/actions/hives";
import { InspectionForm } from "@/components/inspections/inspection-form";
import { createInspection } from "@/actions/inspections";

export default async function QuickInspectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const hive = await getHive(id);
  if (!hive) notFound();

  return (
    <div className="p-6">
      <InspectionForm
        action={createInspection}
        hiveId={id}
        title={`Quick Inspection — ${hive.positionLabel}`}
        submitLabel="Save Quick Inspection"
      />
    </div>
  );
}
