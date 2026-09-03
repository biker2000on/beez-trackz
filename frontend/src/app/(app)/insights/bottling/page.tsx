import type { Metadata } from "next";

import { BottlingView } from "@/features/operations/report-views";

export const metadata: Metadata = { title: "Bottle next" };

export default function BottlingPage() {
  return <BottlingView />;
}
