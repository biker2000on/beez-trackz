import { createSale } from "@/actions/honey";
import { SalesForm } from "@/components/honey/sales-form";

export default async function SellPage() {
  return (
    <div className="p-6">
      <SalesForm
        action={createSale}
        title="Record Sale"
        submitLabel="Save Sale"
      />
    </div>
  );
}
