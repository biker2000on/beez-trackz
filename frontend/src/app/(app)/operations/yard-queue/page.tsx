import type { Metadata } from "next";

import { YardQueuePage } from "@/features/operations/yard-queue";

export const metadata: Metadata = { title: "Yard queue" };

export default function Page() {
  return <YardQueuePage />;
}
