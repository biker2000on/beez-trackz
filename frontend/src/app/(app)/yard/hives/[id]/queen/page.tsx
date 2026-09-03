import type { Metadata } from "next";

import { HiveSubpage } from "@/features/hives/subpage";

export const metadata: Metadata = { title: "Hive queen" };

export default async function HiveQueenPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <HiveSubpage hiveId={id} section="queen" />;
}
