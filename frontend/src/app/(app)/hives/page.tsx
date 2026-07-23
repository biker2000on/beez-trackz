import type { Metadata } from "next";

import { HivesListPage } from "@/features/hives/list-page";

export const metadata: Metadata = { title: "Hives" };

export default function HivesPage() {
  return <HivesListPage />;
}
