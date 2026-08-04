import { HoneySectionNav } from "@/features/honey/section-nav";

/**
 * Honey module chrome. The section menu replaces the old `/harvest` tab strip;
 * it hides itself on the full-screen market-day route.
 */
export default function HoneyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-6">
      <HoneySectionNav />
      {children}
    </div>
  );
}
