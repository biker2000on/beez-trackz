import { Suspense } from "react";

import { StockOnHand } from "@/features/equipment/stock-on-hand";
import { stockTab } from "@/features/equipment/stock-tabs";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/stock");

/**
 * Stock › On hand: bulk honey, packaging and finished goods as tabs of one
 * page (`?tab=`). The three separate pages they replaced redirect here.
 */
export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  return (
    <Suspense>
      <StockOnHand tab={stockTab(tab)} />
    </Suspense>
  );
}
