import type { Metadata } from "next";

import { YardStatusView } from "@/features/dashboard/yard-status-view";

export const metadata: Metadata = { title: "Yard" };

export default function YardPage() {
  return <YardStatusView />;
}
