"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { useBrand } from "@/components/brand-provider";
import {
  isNavRouteActive,
  navPageTitle,
  navRouteChildren,
  resolveNavRoute,
  type NavRoute,
} from "@/components/shell/nav-items";
import { useAccessProfile } from "@/features/access/api";

/**
 * Set the document title from the route index: "Page · Area · Brand".
 *
 * Server pages export `metadata` from `pageMetadata()` for the first paint;
 * this keeps client-rendered titles on the same template and covers the
 * pages that have no server component to export from.
 */
export function usePageTitle(pageTitle: string | undefined) {
  const brand = useBrand();
  React.useEffect(() => {
    if (!pageTitle) return;
    document.title = `${pageTitle} · ${brand.displayName}`;
  }, [pageTitle, brand.displayName]);
}

/**
 * The AreaPage header (ui-coherence brief §5): the one heading grammar for
 * every non-record route.
 *
 * - `h1` is the nav label for the current route, read from `NAV_ITEMS`, so
 *   the sidebar, the phone sheet, Ctrl-K, the tab title and the heading
 *   cannot disagree. `title` overrides it only for pages outside the index
 *   (`/me`).
 * - `subtitle` is one sentence about the task, not the data model.
 * - `actions` holds one primary and at most two secondary controls; anything
 *   more goes in a menu.
 * - `status` is the page-level status line (freshness, offline).
 *
 * On phones the header carries the area's sibling pages as one disclosure
 * labelled "Area · Page" — the desktop sidebar already lists siblings, so
 * there is no in-page strip at `lg` and up. The bottom bar's fifth slot is
 * "More", so the two never share a name.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  status,
  className,
}: {
  title?: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  status?: React.ReactNode;
  className?: string;
}) {
  const pathname = usePathname();
  const resolved = React.useMemo(() => resolveNavRoute(pathname), [pathname]);
  const heading = title ?? resolved?.route.label ?? "";
  const pageTitle = React.useMemo(() => {
    if (title && !resolved) return title;
    if (title && resolved && title !== resolved.route.label) {
      return `${title} · ${resolved.area.label}`;
    }
    return navPageTitle(pathname);
  }, [pathname, resolved, title]);
  usePageTitle(pageTitle);

  return (
    <header className={cn("grid gap-3", className)}>
      {resolved ? (
        <SiblingDisclosure
          area={resolved.area}
          pageLabel={heading}
          pathname={pathname}
        />
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="text-2xl font-bold tracking-tight text-balance">
            {heading}
          </h1>
          {subtitle ? (
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              {subtitle}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>
      {status ? <div className="text-xs text-muted-foreground">{status}</div> : null}
    </header>
  );
}

function SiblingDisclosure({
  area,
  pageLabel,
  pathname,
}: {
  area: NavRoute;
  pageLabel: string;
  pathname: string;
}) {
  const profile = useAccessProfile();
  const isAdmin = profile.data?.isAdmin === true;
  const canEdit =
    isAdmin ||
    profile.data?.memberships.some((entry) => entry.role === "editor") === true;
  const children = navRouteChildren(area, pathname, isAdmin, canEdit);
  const siblings = children.some((child) => child.href === area.href)
    ? children
    : [{ label: area.label, href: area.href, exact: true }, ...children];
  if (siblings.length < 2) return null;
  const label =
    pageLabel === area.label ? area.label : `${area.label} · ${pageLabel}`;

  return (
    <details className="group min-w-0 lg:hidden">
      <summary
        className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground [&::-webkit-details-marker]:hidden"
      >
        {label}
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <nav aria-label={`${area.label} pages`} className="-mx-1 pb-2">
        <ul className="grid gap-0.5">
          {siblings.map((route) => {
            const active = isNavRouteActive(route, pathname);
            return (
              <li key={route.href}>
                <Link
                  href={route.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-11 items-center rounded-md px-3 text-sm transition-colors",
                    active
                      ? "bg-primary/12 font-medium text-primary"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                >
                  {route.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </details>
  );
}
