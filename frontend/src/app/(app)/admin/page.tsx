import type { Metadata } from "next";

import { SettingsView } from "@/features/settings/settings-view";

export const metadata: Metadata = { title: "Admin" };

/**
 * The administrator surface (design 2026-09-03 §2.1). Wave 6 splits
 * `SettingsView` into a per-user half (`/me`) and an administrator half and
 * adds `/admin/setup`; until then both routes render the same component,
 * which already role-gates its own sections, so no user loses a section they
 * can reach today.
 */
export default function AdminPage() {
  return <SettingsView />;
}
