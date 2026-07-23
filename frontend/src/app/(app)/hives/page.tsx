import type { Metadata } from "next";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export const metadata: Metadata = { title: "Hives" };

export default function HivesPage() {
  return (
    <PagePlaceholder
      title="Hives"
      description="Browse, filter, and inspect your hives here soon."
    />
  );
}
