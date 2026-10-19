
import { OperationSetupView } from "@/features/admin/setup-view";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/admin/setup");

export default function OperationSetupPage() {
  return <OperationSetupView />;
}
