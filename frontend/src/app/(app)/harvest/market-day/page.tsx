import type { Metadata } from "next";

import { MarketDayPage } from "@/features/commerce/market-day-page";

export const metadata: Metadata = { title: "Market day" };

export default function MarketDayRoute() {
  return <MarketDayPage />;
}
