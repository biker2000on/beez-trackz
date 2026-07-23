import type { Metadata } from "next";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export const metadata: Metadata = { title: "Queens" };

export default function GenealogyPage() {
  return (
    <PagePlaceholder
      title="Queens"
      description="Queen genealogy and lineage tracking is being built."
    />
  );
}
