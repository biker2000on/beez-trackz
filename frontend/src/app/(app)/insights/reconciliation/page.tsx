
import { ReconciliationView } from "@/features/operations/reconciliation-view";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/insights/reconciliation");

export default function ReconciliationPage() {
  return <ReconciliationView />;
}
