import { pageMetadata } from "@/lib/page-title";
import { ReceiptView } from "@/features/commerce/receipt-view";

// First paint carries the list title; the record header sets "Name · List · Brand".
export const metadata = pageMetadata("/sales");

export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ReceiptView saleId={id} />;
}
