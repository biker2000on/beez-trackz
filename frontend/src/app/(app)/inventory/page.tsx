import type { Metadata } from "next";

import { InventoryView } from "@/features/equipment/inventory-view";

export const metadata: Metadata = { title: "Equipment inventory" };

export default function InventoryPage() {
  return <InventoryView />;
}
