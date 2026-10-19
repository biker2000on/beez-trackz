
import { EquipmentStockView } from "@/features/equipment/stock-view";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/equipment");

export default function EquipmentPage() {
  return <EquipmentStockView />;
}
