
import { YardStatusView } from "@/features/yard/yard-status-view";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/yard");

export default function YardPage() {
  return <YardStatusView />;
}
