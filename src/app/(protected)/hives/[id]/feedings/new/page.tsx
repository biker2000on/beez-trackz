import { notFound } from "next/navigation";
import { getHive } from "@/actions/hives";
import { createFeeding } from "@/actions/feedings";
import { FeedingForm } from "@/components/feedings/feeding-form";

export default async function NewFeedingPage({
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
      <FeedingForm
        action={createFeeding}
        hiveId={id}
        title={`Record Feeding - ${hive.positionLabel}`}
        submitLabel="Record Feeding"
      />
    </div>
  );
}
