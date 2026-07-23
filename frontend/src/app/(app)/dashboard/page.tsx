import type { Metadata } from "next";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <PagePlaceholder
      title="Dashboard"
      description="Your at-a-glance apiary overview is being built."
    />
  );
}
