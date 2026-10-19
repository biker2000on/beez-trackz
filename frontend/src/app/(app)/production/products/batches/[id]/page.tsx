import { ProductBatchRecord } from "@/features/honey/product-batch-record";
import { pageMetadata } from "@/lib/page-title";

// First paint carries the list title; the record header sets "Name · List · Brand".
export const metadata = pageMetadata("/production/products");

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProductBatchRecord id={id} />;
}
