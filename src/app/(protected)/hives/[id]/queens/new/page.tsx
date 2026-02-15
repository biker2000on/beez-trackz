import { notFound } from "next/navigation";
import { createQueen, getAllQueens } from "@/actions/queens";
import { getHive, getHives } from "@/actions/hives";
import { QueenForm } from "@/components/queens/queen-form";

export default async function NewQueenForHivePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [hive, hivesList, queensList] = await Promise.all([
    getHive(id),
    getHives(),
    getAllQueens(),
  ]);

  if (!hive) {
    notFound();
  }

  const hives = hivesList.map((h) => ({
    id: h.id,
    name: `${h.apiaryName} - ${h.positionLabel}`,
  }));

  const queens = queensList.map((q) => ({
    id: q.id,
    label: `${q.hiveName || q.origin} (${q.status})`,
  }));

  return (
    <div className="p-6">
      <QueenForm
        action={createQueen}
        hives={hives}
        queens={queens}
        defaultValues={{ hiveId: id }}
        title={`Add Queen to ${hive.positionLabel}`}
        submitLabel="Create Queen"
      />
    </div>
  );
}
