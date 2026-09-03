import type { Metadata } from "next";

import { SalesWorkbench } from "@/features/workbench/sales-workbench";

export const metadata: Metadata = { title: "Sales workbench" };

/**
 * The canonical sales workbench (design 2026-09-03 §3.3, wave 4).
 *
 * Reachable by URL only in this wave; the navigation rewrite is wave 5. It
 * inherits the existing `/sales` section nav from `sales/layout.tsx`, which
 * is untouched.
 */
export default function SalesWorkbenchPage() {
  return <SalesWorkbench />;
}
