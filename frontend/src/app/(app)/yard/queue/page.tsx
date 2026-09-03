import type { Metadata } from "next";

import { YardQueueView } from "@/features/work/yard-queue-view";

export const metadata: Metadata = { title: "Yard queue" };

export default function YardQueuePage() {
  return <YardQueueView />;
}
