"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  overflowMobileItems,
  primaryMobileItems,
} from "@/components/shell/nav-items";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAccessProfile } from "@/features/access/api";

export function BottomNav() {
  const pathname = usePathname();
  const profile = useAccessProfile();
  const isAdmin = profile.data?.isAdmin === true;
  const [moreOpen, setMoreOpen] = React.useState(false);

  const items = primaryMobileItems(isAdmin);
  const overflow = overflowMobileItems(isAdmin);

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  const overflowActive = overflow.some((item) => isActive(item.href));

  return (
    <>
      <nav
        aria-label="Main navigation"
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur pb-safe md:hidden"
      >
        <ul className="grid grid-cols-5">
          {items.map((item) => {
            const active = isActive(item.href);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors",
                    active
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-5" />
                  {item.shortLabel}
                </Link>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              className={cn(
                "flex w-full flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors",
                overflowActive
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Menu className="size-5" />
              More
            </button>
          </li>
        </ul>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="md:hidden">
          <SheetHeader>
            <SheetTitle>All sections</SheetTitle>
            <SheetDescription>
              Everything not pinned to the bar below.
            </SheetDescription>
          </SheetHeader>
          <ul className="grid grid-cols-2 gap-2 pb-4">
            {overflow.map((item) => {
              const active = isActive(item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setMoreOpen(false)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg border p-3 text-sm font-medium transition-colors",
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "hover:bg-secondary",
                    )}
                  >
                    <Icon className="size-5 shrink-0" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
}
