import {
  ChartNoAxesCombined,
  Droplets,
  MapPin,
  Package,
  Receipt,
  Settings,
  Sun,
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
 *
 * Seven areas, one per first path segment (design 2026-09-03 §2.1). Area
 * ownership is therefore greppable: every authenticated route's first segment
 * names the area that owns it. `/me` is deliberately absent — it is the
 * per-user surface reached from the account menu, not an eighth area.
 */
export const NAV_ITEMS: NavItem[] = [
  {
    label: "Today",
    shortLabel: "Today",
    href: "/today",
    icon: Sun,
    shortcutKey: "t",
    keywords: ["home", "work", "what needs doing"],
    children: [
      {
        label: "Recommendations",
        href: "/today/recommendations",
        keywords: ["actions priorities triage snoozed dismissed"],
      },
    ],
  },
  {
    label: "Yard",
    shortLabel: "Yard",
    href: "/yard",
    icon: MapPin,
    shortcutKey: "y",
    keywords: ["field", "apiary", "apiarty", "yards", "colonies"],
    children: [
      {
        label: "Queue",
        href: "/yard/queue",
        keywords: ["saturday", "field work", "lockout", "harvest"],
      },
      {
        label: "Apiaries",
        href: "/yard/apiaries",
        keywords: ["yards apiary apiarty"],
      },
      { label: "Hives", href: "/yard/hives", keywords: ["colonies"] },
      { label: "Queens", href: "/yard/queens", keywords: ["genealogy lineage"] },
      {
        label: "Voice recording",
        href: "/yard/transcribe",
        keywords: ["batch transcription record apiary voice inspection"],
        requiresEdit: true,
      },
    ],
  },
  {
    label: "Production",
    shortLabel: "Production",
    href: "/production",
    icon: Droplets,
    shortcutKey: "p",
    adminOnly: true,
    keywords: ["honey extraction bottling"],
    children: [
      {
        label: "Workbench",
        href: "/production/workbench",
        keywords: ["open sessions bulk on hand awaiting bottling jar par"],
      },
      {
        label: "Activity",
        href: "/production/activity",
        keywords: ["ledger", "timeline"],
      },
      {
        label: "Production",
        href: "/production/overview",
        matches: [
          "/production/harvests",
          "/production/jars",
          "/production/lots",
          "/production/serials",
          "/production/sessions",
          "/production/products",
          "/production/varietals",
        ],
        children: [
          {
            label: "Harvests",
            href: "/production/harvests",
            keywords: ["extraction sessions"],
          },
          {
            label: "Jars",
            href: "/production/jars",
            keywords: ["bottling stock"],
          },
          {
            label: "Hive products",
            href: "/production/products",
            keywords: ["creamed honey hot honey mead propolis tincture catalog"],
          },
          {
            label: "Varietals",
            href: "/production/varietals",
            keywords: ["varietal lot balances bulk on hand rollup"],
          },
          {
            label: "Lots & QR",
            href: "/production/lots",
            keywords: ["traceability labels"],
            children: [
              {
                label: "Serial lookup",
                href: "/production/serials",
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
        label: "Workbench",
        href: "/sales/workbench",
        keywords: ["takings drafts shortfall settlements due"],
      },
      {
        label: "Market day",
        href: "/sales/market-day",
        keywords: ["point of sale pos"],
      },
      {
        label: "Consignment",
        href: "/sales/consignment",
        keywords: ["bike shop stock locations transfers settlement"],
      },
      {
        label: "Customers & wholesale",
        href: "/sales/customers",
        keywords: ["customer list reorder reminders wholesale price lists"],
      },
      {
        label: "Expenses",
        href: "/sales/expenses",
        keywords: ["money out spend assignable to lots and hives"],
      },
    ],
  },
  {
    label: "Equipment",
    shortLabel: "Gear",
    href: "/equipment",
    icon: Package,
    shortcutKey: "e",
    adminOnly: true,
    // "inventory" is ledger vocabulary now (design §2.3) and is deliberately
    // not a search keyword for hive gear.
    keywords: ["equipment gear stock"],
    children: [
      {
        label: "Types & BOMs",
        href: "/equipment/types",
        keywords: ["equipment types catalog bill of materials assemble variants"],
      },
    ],
  },
  {
    label: "Insights",
    shortLabel: "Insights",
    href: "/insights",
    icon: ChartNoAxesCombined,
    shortcutKey: "i",
    keywords: ["reports analytics"],
    children: [
      {
        label: "Outcomes",
        href: "/insights/outcomes",
        matches: ["/insights/survival", "/insights/yield"],
        children: [
          { label: "Winter survival", href: "/insights/survival" },
          { label: "Honey yield", href: "/insights/yield" },
        ],
      },
      {
        label: "Finance",
        href: "/insights/finance",
        adminOnly: true,
        matches: ["/insights/economics", "/insights/profitability"],
        children: [
          {
            label: "Apiary economics",
            href: "/insights/economics",
            adminOnly: true,
          },
          {
            label: "Profitability",
            href: "/insights/profitability",
            adminOnly: true,
          },
        ],
      },
      {
        label: "Sales & planning",
        href: "/insights/sales-planning",
        adminOnly: true,
        matches: ["/insights/bottling"],
        children: [
          { label: "Bottle next", href: "/insights/bottling", adminOnly: true },
        ],
      },
    ],
  },
  {
    label: "Admin",
    shortLabel: "Admin",
    href: "/admin",
    icon: Settings,
    shortcutKey: "a",
    adminOnly: true,
    keywords: ["settings integrations access api users setup"],
  },
];

/** Context-only destinations that need a real apiary or hive id. */
export function contextualNavRoutes(
  parentHref: string,
  pathname: string,
): NavRoute[] {
  const apiary = pathname.match(/^\/yard\/apiaries\/([^/]+)/)?.[1];
  if (parentHref === "/yard/apiaries" && apiary) {
    const base = `/yard/apiaries/${apiary}`;
    return [
      { label: "Overview", href: base, exact: true },
      { label: "Layout", href: `${base}?tab=layout`, exact: true },
      { label: "Flora", href: `${base}/flora`, keywords: ["blooms forage"] },
      { label: "Photos", href: `${base}/photos` },
      { label: "Print tags", href: `${base}/labels`, keywords: ["labels qr"] },
      { label: "Bulk record", href: `${base}/bulk`, requiresEdit: true },
      {
        label: "Voice walkthrough",
        href: `/yard/transcribe?apiary=${apiary}`,
        requiresEdit: true,
      },
    ];
  }

  const hive = pathname.match(/^\/yard\/hives\/([^/]+)/)?.[1];
  if (parentHref === "/yard/hives" && hive) {
    const base = `/yard/hives/${hive}`;
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
        // One voice surface for the yard (S10): the hive-scoped route is a
        // search param on `/yard/transcribe`, not a route of its own.
        label: "Voice inspection",
        href: `/yard/transcribe?hive=${hive}`,
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
 *
 * One entry per area, so the phone bar can never be a different information
 * architecture from the desktop rail: an admin gets Today / Yard / Production
 * / Sales plus More, and a viewer or editor gets Today / Yard / Insights plus
 * More. Yard is pinned second for every role — it is where Saturday starts —
 * and no admin-only area can push it off the bar.
 */
const MOBILE_PRIORITY = [
  "/today",
  "/yard",
  "/production",
  "/sales",
  "/equipment",
  "/insights",
  "/admin",
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

/**
 * Every area root. `CALM_ROUTES` (`components/install-prompt.tsx`) is
 * derived from this so it cannot go stale the way the hand-written list did:
 * that one still named a redirect-only route and omitted two live ones.
 */
export function navRootHrefs(): string[] {
  return NAV_ITEMS.map((item) => item.href);
}
