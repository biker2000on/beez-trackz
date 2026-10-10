import { Suspense } from "react";
import { StockWorkspace } from "@/features/equipment/stock-workspace";
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
