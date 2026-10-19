
import { BottlingView } from "@/features/operations/report-views";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/insights/bottling");

export default function BottlingPage() {
  return <BottlingView />;
}
