import type { Metadata } from "next";

import { HiveLabelsPage } from "@/features/apiaries/hive-labels-page";

export const metadata: Metadata = { title: "Hive tags" };

export default async function ApiaryLabelsRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <HiveLabelsPage apiaryId={id} />;
}
