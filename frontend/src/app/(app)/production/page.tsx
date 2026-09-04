import type { Metadata } from "next";

import { HoneyOverview } from "@/features/honey/honey-overview";

export const metadata: Metadata = { title: "Production" };

export default function ProductionPage() {
  return <HoneyOverview />;
}
