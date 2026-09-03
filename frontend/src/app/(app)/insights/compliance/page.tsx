import type { Metadata } from "next";

import { ComplianceView } from "@/features/operations/compliance-view";

export const metadata: Metadata = { title: "Compliance packet" };

export default function CompliancePage() {
  return <ComplianceView />;
}
