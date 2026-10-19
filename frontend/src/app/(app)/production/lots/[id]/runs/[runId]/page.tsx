import { BottlingRunRecord } from "@/features/commerce/lot-record";
import { pageMetadata } from "@/lib/page-title";

// First paint carries the list title; the record header sets "Name · List · Brand".
export const metadata = pageMetadata("/production/lots");

export default async function Page({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId } = await params;
  return <BottlingRunRecord lotId={id} runId={runId} />;
}
