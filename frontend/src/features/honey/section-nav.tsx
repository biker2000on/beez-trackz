"use client";

/**
 * Section menu for the Honey module. The old `/harvest` tab strip became real
 * routes, so this is a link bar rather than a `<Tabs>` — every section is
 * deep-linkable and back-button safe for free.
 *
 * Market day is a full-screen point-of-sale route with its own chrome, so the
 * menu hides itself there (a stray click must not abandon a cart mid-sale).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShoppingBasket } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { HoneyQuickActions } from "./quick-actions";

const SECTIONS = [
  { href: "/harvest", label: "Overview" },
  { href: "/harvest/harvests", label: "Harvests" },
  { href: "/harvest/jars", label: "Jars" },
  { href: "/harvest/sales", label: "Sales" },
  { href: "/harvest/lots", label: "Lots & QR" },
  { href: "/harvest/activity", label: "Activity" },
] as const;

export function HoneySectionNav() {
  const pathname = usePathname();
  if (pathname.startsWith("/harvest/market-day")) return null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3">
      <nav aria-label="Honey sections" className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <ul className="inline-flex min-w-max items-center gap-1 rounded-lg bg-muted p-1">
          {SECTIONS.map((section) => {
            const active =
              section.href === "/harvest"
                ? pathname === "/harvest"
                : pathname.startsWith(section.href);
            return (
              <li key={section.href}>
                <Link
                  href={section.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {section.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
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
