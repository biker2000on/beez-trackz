import type { Metadata } from "next";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export const metadata: Metadata = { title: "Inventory" };

export default function InventoryPage() {
  return (
    <PagePlaceholder
      title="Inventory"
      description="Equipment stock, deployments, and frame tracking are being built."
    />
  );
}
