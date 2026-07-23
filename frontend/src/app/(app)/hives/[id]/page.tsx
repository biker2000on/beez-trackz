import type { Metadata } from "next";

import { HiveDetailPage } from "@/features/hives/detail-page";

export const metadata: Metadata = { title: "Hive" };

export default async function HivePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <HiveDetailPage hiveId={id} />;
}
