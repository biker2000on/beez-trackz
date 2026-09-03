import type { Metadata } from "next";

import { ProductionWorkbench } from "@/features/workbench/production-workbench";

export const metadata: Metadata = { title: "Production workbench" };

/**
 * The canonical production workbench (design 2026-09-03 §3.2, wave 4).
 *
 * Reachable by URL only in this wave: `NAV_ITEMS`, the mobile pins, the PWA
 * manifest and the service worker shell are rewritten together in wave 5, and
 * nothing under `/honey/*` is moved, deleted or redirected here.
 */
export default function ProductionWorkbenchPage() {
  return <ProductionWorkbench />;
}
