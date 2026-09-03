import type { Metadata } from "next";

import { TypesView } from "@/features/equipment/types-view";

export const metadata: Metadata = { title: "Equipment types & BOMs" };

export default function EquipmentTypesPage() {
  return <TypesView />;
}
