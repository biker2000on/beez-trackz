import type { Metadata } from "next";

import { SettingsView } from "@/features/settings/settings-view";

export const metadata: Metadata = { title: "My preferences" };

/**
 * The per-user surface (design 2026-09-03 §2.1). Wave 6 splits
 * `SettingsView` into a per-user half and an administrator half; until then
 * both routes render the same component, which already role-gates its own
 * sections, so no user loses a section they can reach today.
 */
export default function MePage() {
  return <SettingsView />;
}
