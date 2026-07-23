import type { Metadata } from "next";

import { ApiaryDetailPage } from "@/features/apiaries/detail-page";

export const metadata: Metadata = { title: "Apiary" };

export default async function ApiaryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ApiaryDetailPage apiaryId={id} />;
}
