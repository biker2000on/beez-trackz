
import { YardQueueView } from "@/features/work/yard-queue-view";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/yard/queue");

export default function YardQueuePage() {
  return <YardQueueView />;
}
