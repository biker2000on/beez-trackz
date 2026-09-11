"use client";
import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "@/components/shell/nav-items";
import { SectionNav } from "@/components/shell/section-nav";
export const PRODUCTION_SECTIONS = NAV_ITEMS.find(item => item.href === "/production")!.children!;
export function ProductionSectionNav() {
  const pathname = usePathname();
  return <SectionNav label="Production pages" sections={PRODUCTION_SECTIONS} rootHref="/production" pathname={pathname} />;
}
