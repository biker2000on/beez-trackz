
import { ComplianceView } from "@/features/operations/compliance-view";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/insights/compliance");

export default function CompliancePage() {
  return <ComplianceView />;
}
