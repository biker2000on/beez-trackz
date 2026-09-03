import type { Metadata } from "next";

import { OperationSetupView } from "@/features/admin/setup-view";

export const metadata: Metadata = { title: "Operation setup" };

export default function OperationSetupPage() {
  return <OperationSetupView />;
}
