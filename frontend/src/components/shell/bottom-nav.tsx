"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import {
  MOBILE_NAV_ITEMS,
  NAV_ITEMS,
  visibleNavItems,
} from "@/components/shell/nav-items";
import { useAccessProfile } from "@/features/access/api";

export function BottomNav() {
  const pathname = usePathname();
  const profile = useAccessProfile();
  const isAdmin = profile.data?.isAdmin === true;
  const items = isAdmin
    ? MOBILE_NAV_ITEMS
    : visibleNavItems(
        [NAV_ITEMS[0], NAV_ITEMS[1], NAV_ITEMS[2], NAV_ITEMS[3], NAV_ITEMS[8]],
        false,
      );

  return (
    <nav
      aria-label="Main navigation"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur pb-safe md:hidden"
    >
      <ul className="grid grid-cols-5">
        {items.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
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
      </ul>
    </nav>
  );
}
