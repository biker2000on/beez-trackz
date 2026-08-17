"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Logo } from "@/components/logo";
import {
  NAV_ITEMS,
  isNavRouteActive,
  navRouteChildren,
  visibleNavItems,
  type NavRoute,
} from "@/components/shell/nav-items";
import { LogoutButton } from "@/components/shell/logout-button";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { CommandPaletteButton } from "@/components/shortcuts/provider";
import { Separator } from "@/components/ui/separator";
import { useAccessProfile } from "@/features/access/api";
import { useHives } from "@/features/hives/hooks";

const DEPTH_PADDING = ["pl-8", "pl-11", "pl-14"];

export function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const currentHref = `${pathname}${query ? `?${query}` : ""}`;
  const profile = useAccessProfile();
  const currentHiveId = pathname.match(/^\/hives\/([^/]+)/)?.[1];
  const hives = useHives({ includeArchived: true }, Boolean(currentHiveId));
  const isAdmin = profile.data?.isAdmin === true;
  const items = visibleNavItems(NAV_ITEMS, isAdmin);
  const [expansion, setExpansion] = React.useState<{
    path: string;
    map: Record<string, boolean>;
  }>({ path: pathname, map: {} });
  const expanded = React.useMemo(
    () => (expansion.path === pathname ? expansion.map : {}),
    [expansion, pathname],
  );
  const navRef = React.useRef<HTMLElement>(null);

  const currentApiaryId = pathname.match(/^\/apiaries\/([^/]+)/)?.[1];
  const currentHive = hives.data?.find((hive) => hive.id === currentHiveId);
  const contextApiaryId = currentApiaryId ?? currentHive?.apiaryId;
  const canEditAny =
    isAdmin || profile.data?.memberships.some((entry) => entry.role === "editor") === true;
  const canEditContext =
    isAdmin ||
    (contextApiaryId
      ? profile.data?.memberships.some(
          (entry) =>
            entry.apiaryId === contextApiaryId && entry.role === "editor",
        ) === true
      : canEditAny);

  React.useEffect(() => {
    const links = navRef.current?.querySelectorAll('[aria-current="page"]');
    links?.[links.length - 1]?.scrollIntoView({ block: "nearest" });
  }, [pathname, currentHref, expanded, items, canEditContext, hives.data]);

  function itemChildren(item: NavRoute) {
    return navRouteChildren(item, pathname, isAdmin, canEditContext);
  }

  function toggle(href: string, defaultOpen: boolean) {
    setExpansion((current) => {
      const map = current.path === pathname ? current.map : {};
      return {
        path: pathname,
        map: { ...map, [href]: !(map[href] ?? defaultOpen) },
      };
    });
  }

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r bg-sidebar pt-[var(--safe-top)] text-sidebar-foreground lg:flex">
      <div className="flex items-center justify-between px-4 py-5">
        <Link
          href="/dashboard"
          className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Logo />
        </Link>
        <ThemeToggle />
      </div>
      <nav
        ref={navRef}
        className="flex-1 overflow-y-auto px-3"
        aria-label="Main navigation"
      >
        <ul className="grid gap-1">
          {items.map((item) => {
            const children = itemChildren(item);
            const active = isNavRouteActive(item, currentHref);
            const Icon = item.icon;
            const open = expanded[item.href] ?? active;
            return (
              <li key={item.href}>
                <div
                  className={cn(
                    "flex items-center rounded-md transition-colors",
                    active
                      ? "bg-primary/12 text-primary"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                >
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Icon className="size-4 shrink-0" />
                    {item.label}
                  </Link>
                  {children.length > 0 && (
                    <button
                      type="button"
                      aria-label={`${open ? "Collapse" : "Expand"} ${item.label}`}
                      aria-expanded={open}
                      onClick={() => toggle(item.href, active)}
                      className="mr-1 grid size-8 shrink-0 place-items-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ChevronDown
                        className={cn(
                          "size-4 transition-transform",
                          !open && "-rotate-90",
                        )}
                      />
                    </button>
                  )}
                </div>
                {children.length > 0 && open && (
                  <ul className="mt-1 grid gap-0.5 border-l border-border/70">
                    {children.map((route) => (
                      <SidebarRoute
                        key={route.href}
                        route={route}
                        depth={0}
                        currentHref={currentHref}
                        expanded={expanded}
                        onToggle={toggle}
                      />
                    ))}
                  </ul>
                )}
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

function SidebarRoute({
  route,
  depth,
  currentHref,
  expanded,
  onToggle,
}: {
  route: NavRoute;
  depth: number;
  currentHref: string;
  expanded: Record<string, boolean>;
  onToggle: (href: string, defaultOpen: boolean) => void;
}) {
  const active = isNavRouteActive(route, currentHref);
  const children = route.children ?? [];
  const open = expanded[route.href] ?? active;
  const padding = DEPTH_PADDING[Math.min(depth, DEPTH_PADDING.length - 1)];

  return (
    <li>
      <div className="flex items-center">
        <Link
          href={route.href}
          aria-current={active ? "page" : undefined}
          className={cn(
            "min-w-0 flex-1 rounded-md py-1.5 pr-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            padding,
            active
              ? "font-medium text-primary"
              : "text-muted-foreground hover:bg-secondary hover:text-foreground",
          )}
        >
          {route.label}
        </Link>
        {children.length > 0 && (
          <button
            type="button"
            aria-label={`${open ? "Collapse" : "Expand"} ${route.label}`}
            aria-expanded={open}
            onClick={() => onToggle(route.href, active)}
            className="mr-1 grid size-7 shrink-0 place-items-center rounded text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform",
                !open && "-rotate-90",
              )}
            />
          </button>
        )}
      </div>
      {children.length > 0 && open && (
        <ul className="grid gap-0.5">
          {children.map((child) => (
            <SidebarRoute
              key={child.href}
              route={child}
              depth={depth + 1}
              currentHref={currentHref}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
