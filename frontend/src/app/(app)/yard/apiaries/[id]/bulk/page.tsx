import { BulkRecordPage } from "@/features/apiaries/bulk-record-page";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <BulkRecordPage apiaryId={id} />;
}
