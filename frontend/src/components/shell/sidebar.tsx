"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import { Logo } from "@/components/logo";
import { NAV_ITEMS, visibleNavItems } from "@/components/shell/nav-items";
import { LogoutButton } from "@/components/shell/logout-button";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { CommandPaletteButton } from "@/components/shortcuts/provider";
import { Separator } from "@/components/ui/separator";
import { useAccessProfile } from "@/features/access/api";

export function Sidebar() {
  const pathname = usePathname();
  const profile = useAccessProfile();
  const items = visibleNavItems(NAV_ITEMS, profile.data?.isAdmin === true);

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex items-center justify-between px-4 py-5">
        <Link
          href="/dashboard"
          className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Logo />
        </Link>
        <ThemeToggle />
      </div>
      <nav className="flex-1 overflow-y-auto px-3" aria-label="Main navigation">
        <ul className="grid gap-1">
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
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "bg-primary/12 text-primary"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="px-3 pb-4">
        <Separator className="mb-3" />
        <CommandPaletteButton />
        <LogoutButton />
      </div>
    </aside>
  );
}
