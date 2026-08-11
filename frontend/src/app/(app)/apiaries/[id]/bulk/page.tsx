import type { Metadata } from "next";

import { BulkRecordPage } from "@/features/apiaries/bulk-record-page";

export const metadata: Metadata = { title: "Bulk record" };

export default async function ApiaryBulkRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <BulkRecordPage apiaryId={id} />;
}
