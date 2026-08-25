import {
  ClipboardList,
  Crown,
  Droplets,
  Hexagon,
  LayoutDashboard,
  ChartNoAxesCombined,
  MapPin,
  Package,
  Receipt,
  Settings,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

export interface NavRoute {
  label: string;
  href: string;
  keywords?: readonly string[];
  matches?: readonly string[];
  /** Match only this path/query destination, not every descendant path. */
  exact?: boolean;
  adminOnly?: boolean;
  requiresEdit?: boolean;
  children?: readonly NavRoute[];
}

export interface NavItem extends NavRoute {
  /** Short label for the mobile bottom nav. */
  shortLabel: string;
  icon: LucideIcon;
  /** Key used in the `g` + key navigation sequence. */
  shortcutKey: string;
}

/**
 * The canonical protected-route index. Desktop/mobile navigation and Ctrl-K
 * all consume this tree so a route cannot be added to one surface and remain
 * hidden from the others.
 */
export const NAV_ITEMS: NavItem[] = [
  {
    label: "Dashboard",
    shortLabel: "Home",
    href: "/dashboard",
    icon: LayoutDashboard,
    shortcutKey: "d",
    keywords: ["home"],
  },
  {
    label: "Yard queue",
    shortLabel: "Queue",
    href: "/operations/yard-queue",
    icon: ClipboardList,
    shortcutKey: "k",
    keywords: ["saturday", "field work", "lockout", "harvest"],
  },
  {
    label: "Apiaries",
    shortLabel: "Yards",
    href: "/apiaries",
    icon: MapPin,
    shortcutKey: "a",
    keywords: ["yards", "apiary", "apiarty"],
    children: [
      {
        label: "Voice walkthrough",
        href: "/transcribe",
        keywords: ["batch transcription", "record apiary"],
        requiresEdit: true,
      },
    ],
  },
  {
    label: "Hives",
    shortLabel: "Hives",
    href: "/hives",
    icon: Hexagon,
    shortcutKey: "h",
    keywords: ["colonies"],
  },
  {
    label: "Honey",
    shortLabel: "Honey",
    href: "/honey",
    icon: Droplets,
    shortcutKey: "y",
    adminOnly: true,
    children: [
      {
        label: "Activity",
        href: "/honey/activity",
        keywords: ["ledger", "timeline"],
      },
      {
        label: "Production",
        href: "/honey/production",
        matches: [
          "/honey/harvests",
          "/honey/jars",
          "/honey/lots",
          "/honey/serials",
          "/honey/sessions",
          "/honey/products",
        ],
        children: [
          { label: "Harvests", href: "/honey/harvests", keywords: ["extraction sessions"] },
          { label: "Jars", href: "/honey/jars", keywords: ["bottling inventory"] },
          {
            label: "Hive products",
            href: "/honey/products",
            keywords: ["creamed honey hot honey mead propolis tincture catalog"],
          },
          {
            label: "Lots & QR",
            href: "/honey/lots",
            keywords: ["traceability labels"],
            children: [
              {
                label: "Serial lookup",
                href: "/honey/serials",
                keywords: ["jar qr lookup"],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    label: "Sales",
    shortLabel: "Sales",
    href: "/sales",
    icon: Receipt,
    shortcutKey: "c",
    adminOnly: true,
    keywords: ["orders receipts colonies equipment creamed mead propolis"],
    children: [
      {
        label: "Market day",
        href: "/sales/market-day",
        keywords: ["point of sale pos"],
      },
      { label: "Consignment", href: "/sales/consignment", keywords: ["bike shop stock locations transfers settlement"] },
    ],
  },
  {
    label: "Equipment",
    shortLabel: "Gear",
    href: "/inventory",
    icon: Package,
    shortcutKey: "i",
    adminOnly: true,
    keywords: ["equipment gear stock inventory"],
  },
  {
    label: "Reports",
    shortLabel: "Reports",
    href: "/reports",
    icon: ChartNoAxesCombined,
    shortcutKey: "o",
    children: [
      {
        label: "Outcomes",
        href: "/reports/outcomes",
        matches: ["/reports/survival", "/reports/yield"],
        children: [
          { label: "Winter survival", href: "/reports/survival" },
          { label: "Honey yield", href: "/reports/yield" },
        ],
      },
      {
        label: "Finance",
        href: "/reports/finance",
        adminOnly: true,
        matches: [
          "/reports/economics",
          "/reports/profitability",
          "/reports/expenses",
        ],
        children: [
          { label: "Apiary economics", href: "/reports/economics", adminOnly: true },
          { label: "Profitability", href: "/reports/profitability", adminOnly: true },
          { label: "Expenses", href: "/reports/expenses", adminOnly: true },
        ],
      },
      {
        label: "Sales & planning",
        href: "/reports/sales-planning",
        adminOnly: true,
        matches: ["/reports/bottling", "/reports/customers"],
        children: [
          { label: "Bottle next", href: "/reports/bottling", adminOnly: true },
          { label: "Customers & wholesale", href: "/reports/customers", adminOnly: true },
        ],
      },
    ],
  },
  {
    label: "Queens",
    shortLabel: "Queens",
    href: "/queens",
    icon: Crown,
    shortcutKey: "q",
    keywords: ["genealogy lineage"],
  },
  {
    label: "Recommendations",
    shortLabel: "Recs",
    href: "/recommendations",
    icon: Sparkles,
    shortcutKey: "r",
    keywords: ["actions priorities"],
  },
  {
    label: "Settings",
    shortLabel: "Settings",
    href: "/settings",
    icon: Settings,
    shortcutKey: "s",
  },
];

/** Context-only destinations that need a real apiary or hive id. */
export function contextualNavRoutes(
  parentHref: string,
  pathname: string,
): NavRoute[] {
  const apiary = pathname.match(/^\/apiaries\/([^/]+)/)?.[1];
  if (parentHref === "/apiaries" && apiary) {
    const base = `/apiaries/${apiary}`;
    return [
      { label: "Overview", href: base, exact: true },
      { label: "Layout", href: `${base}?tab=layout`, exact: true },
      { label: "Flora", href: `${base}/flora`, keywords: ["blooms forage"] },
      { label: "Photos", href: `${base}/photos` },
      { label: "Print tags", href: `${base}/labels`, keywords: ["labels qr"] },
      { label: "Bulk record", href: `${base}/bulk`, requiresEdit: true },
      {
        label: "Voice walkthrough",
        href: `/transcribe?apiary=${apiary}`,
        requiresEdit: true,
      },
    ];
  }

  const hive = pathname.match(/^\/hives\/([^/]+)/)?.[1];
  if (parentHref === "/hives" && hive) {
    const base = `/hives/${hive}`;
    return [
      { label: "Overview", href: base, exact: true },
      {
        label: "Timeline",
        href: `${base}?tab=timeline`,
        exact: true,
        keywords: ["inspections feedings treatments mites splits moves harvests"],
      },
      { label: "Health", href: `${base}?tab=health`, keywords: ["varroa inspections"], exact: true },
      { label: "Equipment", href: `${base}/equipment` },
      { label: "Queen", href: `${base}/queen`, keywords: ["lineage genealogy"] },
      { label: "Photos", href: `${base}/photos` },
      {
        label: "Voice inspection",
        href: `${base}/transcribe`,
        keywords: ["record transcribe"],
        requiresEdit: true,
      },
    ];
  }
  return [];
}

export function visibleNavRoutes<T extends NavRoute>(
  routes: readonly T[],
  isAdmin: boolean,
  canEdit = true,
): T[] {
  return routes
    .filter(
      (route) =>
        (isAdmin || !route.adminOnly) && (canEdit || !route.requiresEdit),
    )
    .map((route) => ({
      ...route,
      children: route.children
        ? visibleNavRoutes(route.children, isAdmin, canEdit)
        : undefined,
    })) as T[];
}

/** Merge static and current-record children without duplicating a label. */
export function navRouteChildren(
  route: NavRoute,
  pathname: string,
  isAdmin: boolean,
  canEdit: boolean,
) {
  const contextual = contextualNavRoutes(route.href, pathname);
  const contextualLabels = new Set(contextual.map((child) => child.label));
  const staticChildren = (route.children ?? []).filter(
    (child) => !contextualLabels.has(child.label),
  );
  return visibleNavRoutes(
    [...staticChildren, ...contextual],
    isAdmin,
    canEdit,
  );
}

/** Backward-compatible name used by top-level navigation callers. */
export function visibleNavItems(items: NavItem[], isAdmin: boolean) {
  return visibleNavRoutes(items, isAdmin);
}

export function routePath(href: string) {
  return href.split("?")[0];
}

export function isNavRouteActive(route: NavRoute, currentHref: string): boolean {
  if (
    route.children?.some((child) => isNavRouteActive(child, currentHref))
  ) {
    return true;
  }
  const [pathname, currentQuery = ""] = currentHref.split("?");
  const path = routePath(route.href);
  if (route.exact) {
    if (pathname !== path) return false;
    const routeQuery = route.href.split("?")[1];
    const currentParams = new URLSearchParams(currentQuery);
    if (!routeQuery) return !currentParams.has("tab");
    const routeParams = new URLSearchParams(routeQuery);
    return Array.from(routeParams).every(
      ([key, value]) => currentParams.get(key) === value,
    );
  }
  return (
    pathname === path ||
    pathname.startsWith(`${path}/`) ||
    (route.matches?.some(
      (match) => pathname === match || pathname.startsWith(`${match}/`),
    ) ?? false)
  );
}

export interface IndexedNavRoute extends NavRoute {
  breadcrumbs: string[];
}

export function flattenNavRoutes(
  routes: readonly NavRoute[],
  parents: readonly string[] = [],
): IndexedNavRoute[] {
  return routes.flatMap((route) => {
    const breadcrumbs = [...parents, route.label];
    return [
      { ...route, breadcrumbs },
      ...flattenNavRoutes(route.children ?? [], breadcrumbs),
    ];
  });
}

/**
 * Order the bottom bar fills its four fixed slots from; the fifth slot is
 * always More. More itself renders the complete folded route tree.
 */
const MOBILE_PRIORITY = [
  "/dashboard",
  "/apiaries",
  "/hives",
  "/honey",
  "/sales",
  "/operations/yard-queue",
  "/inventory",
  "/reports",
  "/recommendations",
  "/queens",
  "/settings",
];

export function primaryMobileItems(isAdmin: boolean): NavItem[] {
  const visible = visibleNavItems(NAV_ITEMS, isAdmin);
  return MOBILE_PRIORITY.map((href) =>
    visible.find((item) => item.href === href),
  )
    .filter((item): item is NavItem => item != null)
    .slice(0, 4);
}

export function overflowMobileItems(isAdmin: boolean): NavItem[] {
  const pinned = new Set(primaryMobileItems(isAdmin).map((item) => item.href));
  return visibleNavItems(NAV_ITEMS, isAdmin).filter(
    (item) => !pinned.has(item.href),
  );
}
