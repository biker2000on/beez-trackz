import type { Metadata } from "next";

import { EquipmentStockView } from "@/features/equipment/stock-view";

export const metadata: Metadata = { title: "Equipment" };

export default function EquipmentPage() {
  return <EquipmentStockView />;
}
