import type { Metadata } from "next";

import { HiveSubpage } from "@/features/hives/subpage";

export const metadata: Metadata = { title: "Hive queen" };

export default async function HiveQueenPage({ params }: PageProps<"/hives/[id]/queen">) {
  const { id } = await params;
  return <HiveSubpage hiveId={id} section="queen" />;
}
