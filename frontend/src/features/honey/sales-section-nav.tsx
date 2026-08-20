"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShoppingBasket } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SectionNav } from "@/components/shell/section-nav";

import { HoneyQuickActions } from "./quick-actions";

export const SALES_SECTIONS = [
  { href: "/sales", label: "Orders" },
  { href: "/sales/consignment", label: "Consignment" },
] as const;

export function SalesSectionNav() {
  const pathname = usePathname();
  if (pathname.startsWith("/sales/market-day")) return null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3">
      <SectionNav
        label="Sales sections"
        sections={SALES_SECTIONS}
        rootHref="/sales"
        pathname={pathname}
      />
      <div className="flex items-center gap-2">
        <HoneyQuickActions variant="menu" />
        <Button asChild size="sm" variant="outline">
          <Link href="/sales/market-day">
            <ShoppingBasket />
            Market day
          </Link>
        </Button>
      </div>
    </div>
  );
}
