import { notFound } from "next/navigation";
import { getApiary, updateApiary } from "@/actions/apiaries";
import { ApiaryForm } from "@/components/apiaries/apiary-form";

export default async function EditApiaryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const apiary = await getApiary(id);

  if (!apiary) {
    notFound();
  }

  const updateWithId = updateApiary.bind(null, id);

  return (
    <div className="p-6">
      <ApiaryForm
        action={updateWithId}
        defaultValues={apiary}
        title="Edit Apiary"
        submitLabel="Save Changes"
      />
    </div>
  );
}
