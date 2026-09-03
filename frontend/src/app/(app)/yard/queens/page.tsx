import type { Metadata } from "next";

import { GenealogyView } from "@/features/queens/genealogy-view";

export const metadata: Metadata = { title: "Queens" };

export default function GenealogyPage() {
  return <GenealogyView />;
}
