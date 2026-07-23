import type { Metadata } from "next";

import { PagePlaceholder } from "@/components/shell/page-placeholder";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <PagePlaceholder
      title="Settings"
      description="Preferences, AI configuration, and jar sizes are being built."
    />
  );
}
