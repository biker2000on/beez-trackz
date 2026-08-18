import { SalesSectionNav } from "@/features/honey/sales-section-nav";

export default function SalesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-6">
      <SalesSectionNav />
      {children}
    </div>
  );
}
