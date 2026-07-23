import type { Metadata } from "next";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export const metadata: Metadata = { title: "Recommendations" };

export default function RecommendationsPage() {
  return (
    <PagePlaceholder
      title="Recommendations"
      description="Smart hive-care recommendations will appear here."
    />
  );
}
