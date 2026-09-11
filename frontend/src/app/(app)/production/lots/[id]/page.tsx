import { LotRecord } from "@/features/commerce/lot-record";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id } = await params;
  return <LotRecord id={id} />;
}
