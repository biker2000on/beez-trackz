import { ProductionSectionNav } from "@/features/honey/section-nav";

/**
 * Production chrome. The section menu replaces the old tab strip; it hides
 * itself on the workbench, which is a single-read screen.
 */
export default function ProductionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-6">
      <ProductionSectionNav />
      {children}
    </div>
  );
}
