import type { Metadata } from "next";

import { ProductionOverview } from "@/features/honey/production-overview";

export const metadata: Metadata = { title: "Honey production" };

export default function HoneyProductionPage() {
  return <ProductionOverview />;
}
