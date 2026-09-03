import type { Metadata } from "next";

import { ReconciliationView } from "@/features/operations/reconciliation-view";

export const metadata: Metadata = { title: "GnuCash reconciliation" };

export default function ReconciliationPage() {
  return <ReconciliationView />;
}
