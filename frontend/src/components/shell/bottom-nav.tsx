"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronDown, Menu } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  NAV_ITEMS,
  isNavRouteActive,
  navRouteChildren,
  overflowMobileItems,
  primaryMobileItems,
  visibleNavItems,
  type NavRoute,
} from "@/components/shell/nav-items";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAccessProfile } from "@/features/access/api";
import { useHives } from "@/features/hives/hooks";

export function BottomNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const currentHref = `${pathname}${query ? `?${query}` : ""}`;
  const profile = useAccessProfile();
  const currentHiveId = pathname.match(/^\/hives\/([^/]+)/)?.[1];
  const hives = useHives({ includeArchived: true }, Boolean(currentHiveId));
  const isAdmin = profile.data?.isAdmin === true;
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});

  const items = primaryMobileItems(isAdmin);
  const allItems = visibleNavItems(NAV_ITEMS, isAdmin);
  const overflow = overflowMobileItems(isAdmin);

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

  const overflowActive = overflow.some((item) =>
    isNavRouteActive(item, currentHref),
  );

  function toggle(href: string, defaultOpen: boolean) {
    setExpanded((current) => ({
      ...current,
      [href]: !(current[href] ?? defaultOpen),
    }));
  }

  return (
    <>
      <nav
        aria-label="Main navigation"
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur pb-safe md:hidden"
      >
        <ul className="grid grid-cols-5">
          {items.map((item) => {
            const active = isNavRouteActive(item, currentHref);
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
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto md:hidden">
          <SheetHeader>
            <SheetTitle>All sections</SheetTitle>
            <SheetDescription>
              Expand a section to reach every page underneath it.
            </SheetDescription>
          </SheetHeader>
          <ul className="grid gap-2 pb-4">
            {allItems.map((item) => {
              const children = navRouteChildren(
                item,
                pathname,
                isAdmin,
                canEditContext,
              );
              const active = isNavRouteActive(item, currentHref);
              const open = expanded[item.href] ?? active;
              const Icon = item.icon;
              return (
                <li key={item.href} className="rounded-lg border">
                  <div className="flex items-center">
                    <Link
                      href={item.href}
                      onClick={() => setMoreOpen(false)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-3 rounded-lg p-3 text-sm font-medium transition-colors",
                        active ? "text-primary" : "hover:bg-secondary",
                      )}
                    >
                      <Icon className="size-5 shrink-0" />
                      {item.label}
                    </Link>
                    {children.length > 0 && (
                      <button
                        type="button"
                        aria-label={`${open ? "Collapse" : "Expand"} ${item.label}`}
                        aria-expanded={open}
                        onClick={() => toggle(item.href, active)}
                        className="mr-2 grid size-10 shrink-0 place-items-center rounded-md"
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
                    <ul className="grid gap-1 border-t p-2">
                      {children.map((route) => (
                        <MobileRoute
                          key={route.href}
                          route={route}
                          depth={0}
                          currentHref={currentHref}
                          expanded={expanded}
                          onToggle={toggle}
                          onNavigate={() => setMoreOpen(false)}
                        />
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
}

function MobileRoute({
  route,
  depth,
  currentHref,
  expanded,
  onToggle,
  onNavigate,
}: {
  route: NavRoute;
  depth: number;
  currentHref: string;
  expanded: Record<string, boolean>;
  onToggle: (href: string, defaultOpen: boolean) => void;
  onNavigate: () => void;
}) {
  const active = isNavRouteActive(route, currentHref);
  const children = route.children ?? [];
  const open = expanded[route.href] ?? active;

  return (
    <li>
      <div className="flex items-center">
        <Link
          href={route.href}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          style={{ paddingLeft: `${0.75 + depth * 0.75}rem` }}
          className={cn(
            "min-w-0 flex-1 rounded-md py-2 pr-2 text-sm transition-colors",
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
            className="grid size-9 shrink-0 place-items-center rounded-md"
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
        <ul className="grid gap-1">
          {children.map((child) => (
            <MobileRoute
              key={child.href}
              route={child}
              depth={depth + 1}
              currentHref={currentHref}
              expanded={expanded}
              onToggle={onToggle}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
