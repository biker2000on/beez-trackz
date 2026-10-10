import type { Metadata } from "next";

import { ReconciliationView } from "@/features/operations/reconciliation-view";

export const metadata: Metadata = { title: "Folio reconciliation" };

export default function ReconciliationPage() {
  return <ReconciliationView />;
}
