"use client";

/**
 * Section menu for the Honey module. The old tab strip became real
 * routes, so this is a link bar rather than a `<Tabs>` — every section is
 * deep-linkable and back-button safe for free.
 *
 * Overview and Production stay here; Sales is a top-level destination.
 * Detail routes resolve to their parent group without changing the visible
 * navigation, so the chrome never jumps when opening Activity or a QR lookup.
 *
 * Market day is a full-screen point-of-sale route with its own chrome, so the
 * menu hides itself there (a stray click must not abandon a cart mid-sale).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShoppingBasket } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SectionNav } from "@/components/shell/section-nav";

import { HoneyQuickActions } from "./quick-actions";

export const HONEY_SECTIONS = [
  {
    href: "/honey",
    label: "Overview",
    matches: ["/honey/activity"],
  },
  {
    href: "/honey/production",
    label: "Production",
    matches: [
      "/honey/harvests",
      "/honey/jars",
      "/honey/lots",
      "/honey/serials",
      "/honey/sessions",
      "/honey/products",
    ],
  },
] as const;

export function HoneySectionNav() {
  const pathname = usePathname();
  if (pathname.startsWith("/honey/market-day") || pathname.startsWith("/sales/market-day")) return null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3">
      <SectionNav
        label="Honey sections"
        sections={HONEY_SECTIONS}
        rootHref="/honey"
        pathname={pathname}
      />
      <div className="flex items-center gap-2">
        {/* The overview owns the quick-action row; on sub-routes the same six
            dialogs (and their shortcuts) live behind this menu. */}
        {pathname !== "/honey" && <HoneyQuickActions variant="menu" />}
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
