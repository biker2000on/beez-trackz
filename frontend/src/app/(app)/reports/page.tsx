import type { Metadata } from "next";

import { OperationsDashboard } from "@/features/operations/operations-dashboard";

export const metadata: Metadata = { title: "Operation reports" };

export default function ReportsPage() {
  return <OperationsDashboard />;
}
