import type { Metadata } from "next";

import { ReceiptView } from "@/features/commerce/receipt-view";

export const metadata: Metadata = { title: "Receipt" };

export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ReceiptView saleId={id} />;
}
