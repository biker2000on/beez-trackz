import type { Metadata } from "next";

import { HoneyHub } from "@/features/honey/honey-hub";

export const metadata: Metadata = { title: "Honey" };

export default function HarvestPage() {
  return <HoneyHub />;
}
