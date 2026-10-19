"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft, MoreHorizontal } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageTitle } from "@/components/shell/page-header";
import {
  contextualNavRoutes,
  isNavRouteActive,
  resolveNavRoute,
  visibleNavRoutes,
  type NavRoute,
} from "@/components/shell/nav-items";

/**
 * The RecordPage header (ui-coherence brief §5): one skeleton for every
 * record — hive, apiary, lot, bottling run, harvest session, product batch,
 * order, consignment location, stock item.
 *
 * Reading order, top to bottom: the way back to the list the record belongs
 * to; the record's name with its status badge; one context line; the action
 * bar (one primary, at most two secondary, the rest behind More); the tab
 * strip. The route layout renders it once, so every tab of a record shares
 * the same h1, the same actions and the same strip.
 *
 * The list link, the `<title>` ("Name · Collection · Brand"; `collectionLabel`
 * on the index entry overrides the nav label there) and the tabs are
 * all read from the route index: `collectionHref` names the list in
 * `NAV_ITEMS` (defaulting to the index entry that covers the current path)
 * and `tabs` come from `contextualNavRoutes`, never from a hand-written list.
 */
export function RecordHeader({
  name,
  status,
  context,
  primary,
  secondary,
  more,
  tabs,
  tabsLabel,
  collectionHref,
  className,
  children,
}: {
  name: string;
  /** Status badges, drawn beside the name. */
  status?: React.ReactNode;
  /** Context facts, joined with " · " on one line. Falsy entries are skipped. */
  context?: React.ReactNode[];
  /** The one primary action; big and full-width on a phone. */
  primary?: React.ReactNode;
  /** At most two secondary actions. Anything more belongs in `more`. */
  secondary?: React.ReactNode;
  /** DropdownMenu items for the More menu. */
  more?: React.ReactNode;
  tabs?: NavRoute[];
  /** Accessible name of the tab strip, e.g. "Hive pages". */
  tabsLabel?: string;
  /**
   * The list this record belongs to, as its `NAV_ITEMS` href. Defaults to the
   * index entry that covers the current path.
   */
  collectionHref?: string;
  className?: string;
  /** Record-level notices (lockouts, holds) under the context line. */
  children?: React.ReactNode;
}) {
  const pathname = usePathname();
  const collection = React.useMemo(
    () => resolveNavRoute(collectionHref ?? pathname),
    [collectionHref, pathname],
  );
  const collectionLabel = collection
    ? collection.route.breadcrumbs.length === 1
      ? collection.area.label
      : collection.route.label
    : undefined;
  const collectionTo = collectionHref ?? collection?.route.href;
  const titleLabel = collection?.route.collectionLabel ?? collectionLabel;
  usePageTitle(titleLabel ? `${name} · ${titleLabel}` : name);

  const facts = (context ?? []).filter(
    (entry) => entry != null && entry !== false && entry !== "",
  );
  const hasActions = Boolean(primary || secondary || more);

  return (
    <header className={cn("grid gap-3", className)}>
      {collectionLabel && collectionTo ? (
        <Link
          href={collectionTo}
          className="inline-flex min-h-9 w-fit items-center gap-1 text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {collectionLabel}
        </Link>
      ) : null}
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="min-w-0 text-2xl font-bold tracking-tight text-balance">
            {name}
          </h1>
          {status}
        </div>
        {facts.length > 0 ? (
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-muted-foreground">
            {facts.map((fact, index) => (
              <React.Fragment key={index}>
                {index > 0 ? <span aria-hidden>·</span> : null}
                <span className="inline-flex min-w-0 items-center gap-1">
                  {fact}
                </span>
              </React.Fragment>
            ))}
          </p>
        ) : null}
        {children}
      </div>
      {hasActions ? (
        <div className="flex flex-wrap items-center gap-2 [&>a]:min-h-11 [&>button]:min-h-11 sm:[&>a]:min-h-9 sm:[&>button]:min-h-9">
          {primary ? (
            <div className="flex basis-full sm:basis-auto [&>*]:min-h-11 [&>*]:flex-1 sm:[&>*]:min-h-9 sm:[&>*]:flex-none">
              {primary}
            </div>
          ) : null}
          {secondary}
          {more ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" aria-label="More actions">
                  <MoreHorizontal className="size-4" />
                  More
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">{more}</DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}
      {tabs && tabs.length > 0 ? (
        <RecordTabs tabs={tabs} label={tabsLabel ?? "Record pages"} />
      ) : null}
    </header>
  );
}

/**
 * The record's tab strip. It never wraps: at phone width it scrolls sideways
 * inside its own box (DESIGN.md allows this for record tabs) and the active
 * tab is brought into view, so the strip reads the same on every tab.
 */
function RecordTabs({ tabs, label }: { tabs: NavRoute[]; label: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const currentHref = query ? `${pathname}?${query}` : pathname;
  const scroller = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    const nav = scroller.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || nav.clientWidth === 0) return;
    // Measured against the strip itself: `offsetLeft` would be relative to
    // the nearest positioned ancestor, which is not the strip.
    const navRect = nav.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    const left = rect.left - navRect.left + nav.scrollLeft;
    const right = left + rect.width;
    if (left < nav.scrollLeft) nav.scrollLeft = Math.max(0, left - 16);
    else if (right > nav.scrollLeft + nav.clientWidth) {
      nav.scrollLeft = right - nav.clientWidth + 16;
    }
  }, [currentHref, tabs]);

  return (
    <nav
      ref={scroller}
      aria-label={label}
      className="-mx-3 overflow-x-auto overscroll-x-contain px-3 [scrollbar-width:none] sm:-mx-5 sm:px-5 lg:mx-0 lg:px-0 [&::-webkit-scrollbar]:hidden"
    >
      <ul className="flex min-w-max gap-1 border-b">
        {tabs.map((tab) => {
          const active = isNavRouteActive(tab, currentHref);
          return (
            <li key={tab.href} className="shrink-0">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The record's tabs for this viewer: `contextualNavRoutes` minus the actions. */
export function useRecordTabs(
  parentHref: string,
  isAdmin: boolean,
  canEdit: boolean,
): NavRoute[] {
  const pathname = usePathname();
  return React.useMemo(
    () =>
      visibleNavRoutes(
        contextualNavRoutes(parentHref, pathname),
        isAdmin,
        canEdit,
      ).filter((route) => !route.action),
    [parentHref, pathname, isAdmin, canEdit],
  );
}

/** The record's workflow entry points (`action` routes) for this viewer. */
export function useRecordActions(
  parentHref: string,
  isAdmin: boolean,
  canEdit: boolean,
): NavRoute[] {
  const pathname = usePathname();
  return React.useMemo(
    () =>
      visibleNavRoutes(
        contextualNavRoutes(parentHref, pathname),
        isAdmin,
        canEdit,
      ).filter((route) => route.action),
    [parentHref, pathname, isAdmin, canEdit],
  );
}

/** Reserves the header's rows while the record loads, so the body never jumps. */
export function RecordHeaderSkeleton({
  tabs = 0,
  actions = true,
}: {
  tabs?: number;
  actions?: boolean;
}) {
  return (
    <div className="grid gap-3" aria-busy>
      <Skeleton className="h-5 w-20" />
      <div className="grid gap-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-11 w-full rounded-md sm:h-9 sm:w-40" />
          <Skeleton className="h-9 w-28 rounded-md" />
          <Skeleton className="h-9 w-20 rounded-md" />
        </div>
      ) : null}
      {tabs > 0 ? (
        <div className="flex gap-1 border-b pb-2">
          {Array.from({ length: tabs }, (_, index) => (
            <Skeleton key={index} className="h-7 w-20 rounded-md" />
          ))}
        </div>
      ) : null}
    </div>
  );
}
