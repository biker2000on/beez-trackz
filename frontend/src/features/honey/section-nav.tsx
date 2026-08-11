"use client";

/**
 * Section menu for the Honey module. The old `/harvest` tab strip became real
 * routes, so this is a link bar rather than a `<Tabs>` — every section is
 * deep-linkable and back-button safe for free.
 *
 * Serial lookup and the activity ledger keep their routes but not strip
 * slots: serials are reached from Lots & QR (and by scanning), activity from
 * the overview's recent-activity card. Five destinations fit a phone.
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

const SECTIONS = [
  { href: "/harvest", label: "Overview" },
  { href: "/harvest/harvests", label: "Harvests" },
  { href: "/harvest/jars", label: "Jars" },
  { href: "/harvest/sales", label: "Sales" },
  { href: "/harvest/lots", label: "Lots & QR" },
  // Not in the strip, but still resolved as active for the select on small
  // screens when the user lands there via a link or QR scan.
  { href: "/harvest/serials", label: "Serial lookup" },
  { href: "/harvest/activity", label: "Activity" },
] as const;

const STRIP = SECTIONS.slice(0, 5);

export function HoneySectionNav() {
  const pathname = usePathname();
  if (pathname.startsWith("/harvest/market-day")) return null;

  const onHiddenSection =
    pathname.startsWith("/harvest/serials") ||
    pathname.startsWith("/harvest/activity");

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3">
      <SectionNav
        label="Honey sections"
        sections={onHiddenSection ? SECTIONS : STRIP}
        rootHref="/harvest"
        pathname={pathname}
      />
      <div className="flex items-center gap-2">
        {/* The overview owns the quick-action row; on sub-routes the same six
            dialogs (and their shortcuts) live behind this menu. */}
        {pathname !== "/harvest" && <HoneyQuickActions variant="menu" />}
        <Button asChild size="sm" variant="outline">
          <Link href="/harvest/market-day">
            <ShoppingBasket />
            Market day
          </Link>
        </Button>
      </div>
    </div>
  );
}
