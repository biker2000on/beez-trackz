import type { Metadata } from "next";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export const metadata: Metadata = { title: "Apiaries" };

export default function ApiariesPage() {
  return (
    <PagePlaceholder
      title="Apiaries"
      description="Manage your bee yards, layouts, and blooms here soon."
    />
  );
}
