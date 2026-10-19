/** The three ledger kinds Stock › On hand shows as tabs (`?tab=`). */
export const STOCK_TABS = [
  { id: "bulk", label: "Bulk honey", manage: { href: "/production/lots", label: "Manage lots" } },
  { id: "packaging", label: "Packaging", manage: null },
  { id: "finished", label: "Finished goods", manage: { href: "/production/jars", label: "Bottling" } },
] as const;

export type StockTab = (typeof STOCK_TABS)[number]["id"];

export function stockTab(value: string | undefined): StockTab {
  return STOCK_TABS.some((entry) => entry.id === value) ? (value as StockTab) : "bulk";
}
