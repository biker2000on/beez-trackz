
import { TypesView } from "@/features/equipment/types-view";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/equipment/types");

export default function EquipmentTypesPage() {
  return <TypesView />;
}
