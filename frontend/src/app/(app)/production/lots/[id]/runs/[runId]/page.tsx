import { BottlingRunRecord } from "@/features/commerce/lot-record";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId } = await params;
  return <BottlingRunRecord lotId={id} runId={runId} />;
}
