import { ApiaryForm } from "@/components/apiaries/apiary-form";
import { createApiary } from "@/actions/apiaries";

export default function NewApiaryPage() {
  return (
    <div className="p-6">
      <ApiaryForm
        action={createApiary}
        title="New Apiary"
        submitLabel="Create Apiary"
      />
    </div>
  );
}
