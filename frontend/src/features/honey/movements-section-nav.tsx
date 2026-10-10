"use client";

import { usePathname } from "next/navigation";

import { NAV_ITEMS } from "@/components/shell/nav-items";
import { SectionNav } from "@/components/shell/section-nav";

const STOCK_SECTIONS = NAV_ITEMS.find((item) => item.href === "/stock")!.children!;

/** The Stock area's page menu, as the other Stock pages show it. */
export function MovementsSectionNav() {
  const pathname = usePathname();
  return (
    <SectionNav
      label="Stock pages"
      sections={STOCK_SECTIONS}
      rootHref="/stock"
      pathname={pathname}
    />
  );
}
