
import { MarketDayPage } from "@/features/commerce/market-day-page";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/sales/market-day");

export default function MarketDayRoute() {
  return <MarketDayPage />;
}
