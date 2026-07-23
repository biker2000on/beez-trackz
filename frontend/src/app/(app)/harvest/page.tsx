import type { Metadata } from "next";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export const metadata: Metadata = { title: "Honey" };

export default function HarvestPage() {
  return (
    <PagePlaceholder
      title="Honey"
      description="Harvests, jarring, sales, and the honey ledger are being built."
    />
  );
}
