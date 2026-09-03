import type { Metadata } from "next";

import { MeView } from "@/features/me/me-view";

export const metadata: Metadata = { title: "My preferences" };

export default function MePage() {
  return <MeView />;
}
