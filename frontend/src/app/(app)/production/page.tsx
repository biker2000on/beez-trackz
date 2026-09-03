import type { Metadata } from "next";

import { HoneyOverview } from "@/features/honey/honey-overview";

export const metadata: Metadata = { title: "Honey" };

export default function HoneyPage() {
  return <HoneyOverview />;
}
