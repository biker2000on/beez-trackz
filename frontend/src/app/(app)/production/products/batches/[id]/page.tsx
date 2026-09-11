import { ProductBatchRecord } from "@/features/honey/product-batch-record";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProductBatchRecord id={id} />;
}
