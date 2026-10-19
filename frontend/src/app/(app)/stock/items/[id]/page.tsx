import { Suspense } from "react";
import { StockWorkspace } from "@/features/equipment/stock-workspace";
import { pageMetadata } from "@/lib/page-title";

// First paint carries the list title; the record header sets "Name · List · Brand".
export const metadata = pageMetadata("/stock");

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense>
      <StockWorkspace itemId={id} />
    </Suspense>
  );
}
