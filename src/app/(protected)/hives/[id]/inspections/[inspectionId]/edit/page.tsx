import { notFound } from "next/navigation";
import { getHive } from "@/actions/hives";
import { getInspection, updateInspection } from "@/actions/inspections";
import { InspectionForm } from "@/components/inspections/inspection-form";

export default async function EditInspectionPage({
  params,
}: {
  params: Promise<{ id: string; inspectionId: string }>;
}) {
  const { id, inspectionId } = await params;
  const [hive, inspection] = await Promise.all([
    getHive(id),
    getInspection(inspectionId),
  ]);

  if (!hive || !inspection) {
    notFound();
  }

  const updateAction = updateInspection.bind(null, inspectionId);

  // Normalize pest/treatment data for the form defaults
  const pests = Array.isArray(inspection.pests)
    ? (inspection.pests as { type: string; count: number }[])
    : [];
  const treatments = Array.isArray(inspection.treatments)
    ? (inspection.treatments as {
        product: string;
        method: string;
        dateApplied: string;
        dateToRemove: string;
      }[])
    : [];

  return (
    <div className="p-6">
      <InspectionForm
        action={updateAction}
        hiveId={id}
        defaultValues={{
          date: inspection.date,
          inspectorName: inspection.inspectorName,
          queenSeen: inspection.queenSeen,
          queenHealth: inspection.queenHealth,
          broodPattern: inspection.broodPattern,
          storesHoney: inspection.storesHoney,
          storesPollen: inspection.storesPollen,
          temperament: inspection.temperament,
          pests,
          treatments,
          notes: inspection.notes,
        }}
        title={`Edit Inspection - ${hive.positionLabel}`}
        submitLabel="Update Inspection"
      />
    </div>
  );
}
