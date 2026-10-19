import { pageMetadata } from "@/lib/page-title";
import { SessionDetail } from "@/features/honey/session-detail";

// First paint carries the list title; the record header sets "Name · List · Brand".
export const metadata = pageMetadata("/production/harvests");

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SessionDetail id={id} />;
}
