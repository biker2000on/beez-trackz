import { createQueen, getAllQueens } from "@/actions/queens";
import { getHives } from "@/actions/hives";
import { QueenForm } from "@/components/queens/queen-form";

export default async function NewQueenPage() {
  const [hivesList, queensList] = await Promise.all([
    getHives(),
    getAllQueens(),
  ]);

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
        title="Add Queen"
        submitLabel="Create Queen"
      />
    </div>
  );
}
