import {
  ChartNoAxesCombined,
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
  /**
   * How a record of this list names the list in its `<title>` ("Lenoir
   * Apiary · Apiaries · Brand"), when the nav label ("Apiary list") would
   * read oddly there. The way-back link keeps the nav label.
   */
  collectionLabel?: string;
  adminOnly?: boolean;
  requiresEdit?: boolean;
  /**
   * A shortcut to a page another area owns. It is listed for wayfinding but
   * never marks its parent area active: only the owning area lights up.
   */
  alias?: boolean;
  /**
   * In the route index (Ctrl-K, `<title>`, the h1) but not drawn as a nav
   * row: the sidebar, the phone More sheet and the page disclosure skip it.
   */
  paletteOnly?: boolean;
  /**
   * A workflow entry point on a record (Record visit, Voice inspection): in
   * the sidebar and Ctrl-K like any route, but the record header draws it in
   * the action bar, never in the tab strip.
   */
  action?: boolean;
  /** Descendant paths another area owns, so this prefix must not claim them. */
  excludes?: readonly string[];
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
 * The canonical protected-route index. The sidebar, the phone bar, the page
 * header (h1, `<title>`, phone disclosure) and Ctrl-K all consume this tree,
 * so a destination cannot be added to one surface and stay hidden from the
 * others, and a concept cannot carry two names.
 *
 * Five areas (ui-coherence brief 2026-10-19 §3). URLs did not change; the
 * tree groups by task, not by first path segment: Equipment sits under
 * Apiaries, Production's pages are Stock's, the Visit queue is Today's.
 * `/me` is deliberately absent — it is the per-user surface reached from the
 * account link. Setup is not an area either; see `SETUP_ITEM`.
 */
export const NAV_ITEMS: NavItem[] = [
  {
    label: "Today",
    shortLabel: "Today",
    href: "/today",
    icon: Sun,
    shortcutKey: "t",
    keywords: ["dashboard recommendations work"],
    children: [
      {
        label: "Visit queue",
        href: "/yard/queue",
        keywords: ["yard queue saturday work by apiary field"],
      },
    ],
  },
  {
    label: "Apiaries",
    shortLabel: "Apiaries",
    href: "/yard",
    icon: MapPin,
    shortcutKey: "y",
    keywords: ["yard field colonies"],
    excludes: ["/yard/queue"],
    children: [
      {
        label: "Apiary list",
        href: "/yard/apiaries",
        collectionLabel: "Apiaries",
        keywords: ["roster yards"],
      },
      { label: "Hives", href: "/yard/hives", keywords: ["colonies"] },
      { label: "Queens", href: "/yard/queens", keywords: ["genealogy lineage"] },
      {
        label: "Equipment",
        href: "/equipment",
        exact: true,
        keywords: ["gear counts deploy loss supers boxes frames"],
      },
      {
        label: "Voice inspection",
        href: "/yard/transcribe",
        requiresEdit: true,
        keywords: ["record transcribe visit walkthrough"],
      },
    ],
  },
  {
    label: "Stock",
    shortLabel: "Stock",
    href: "/stock",
    icon: Package,
    shortcutKey: "s",
    adminOnly: true,
    matches: ["/production"],
    excludes: ["/production/varietals"],
    keywords: ["inventory honey production"],
    children: [
      {
        label: "On hand",
        href: "/stock",
        exact: true,
        keywords: ["bulk honey packaging finished goods jars inventory"],
      },
      {
        label: "In progress",
        href: "/production",
        exact: true,
        keywords: ["active batches production workbench extraction sessions"],
      },
      {
        label: "Harvests",
        href: "/production/harvests",
        matches: ["/production/sessions"],
        keywords: ["harvest history extraction"],
      },
      { label: "Bottling", href: "/production/jars", keywords: ["jars jarring runs"] },
      { label: "Lots & labels", href: "/production/lots", keywords: ["qr traceability"] },
      {
        label: "Hive products",
        href: "/production/products",
        keywords: ["creamed hot mead propolis tincture batches"],
      },
      {
        label: "Movements",
        href: "/stock/movements",
        keywords: ["activity ledger jarring sales give-aways adjustments"],
      },
      {
        label: "Serial lookup",
        href: "/production/serials",
        paletteOnly: true,
        keywords: ["jar serial trace"],
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
    keywords: ["commerce orders"],
    children: [
      { label: "Orders", href: "/sales", exact: true, keywords: ["register receipts"] },
      { label: "Market day", href: "/sales/market-day", keywords: ["pos register cart"] },
      { label: "Consignment", href: "/sales/consignment", keywords: ["locations settlements"] },
      { label: "Customers", href: "/sales/customers", keywords: ["wholesale price lists"] },
      { label: "Expenses", href: "/sales/expenses", exact: true, keywords: ["money out"] },
      {
        label: "Categorize",
        href: "/sales/expenses/categorize",
        paletteOnly: true,
        keywords: ["folio imported uncategorized income refunds bulk"],
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
        children: [
          { label: "Winter survival", href: "/insights/survival", paletteOnly: true },
          { label: "Honey yield", href: "/insights/yield", paletteOnly: true },
        ],
      },
      {
        label: "Finance",
        href: "/insights/finance",
        adminOnly: true,
        children: [
          { label: "Apiary economics", href: "/insights/economics", paletteOnly: true },
          { label: "Profitability", href: "/insights/profitability", paletteOnly: true },
        ],
      },
      {
        label: "Sales & planning",
        href: "/insights/sales-planning",
        adminOnly: true,
        children: [
          { label: "Bottle next", href: "/insights/bottling", paletteOnly: true },
        ],
      },
      { label: "Compliance packet", href: "/insights/compliance", adminOnly: true },
      {
        label: "Folio reconciliation",
        href: "/insights/reconciliation",
        adminOnly: true,
        keywords: ["gnucash"],
      },
    ],
  },
];

/**
 * Setup is not an area: it is the sidebar footer link and a row in the phone
 * More sheet, and `g a` still reaches it. Its children are the catalogs the
 * areas work from; they used to be scattered under Production and Equipment.
 */
export const SETUP_ITEM: NavItem = {
  label: "Setup",
  shortLabel: "Setup",
  href: "/admin/setup",
  icon: Settings,
  shortcutKey: "a",
  adminOnly: true,
  keywords: ["admin settings configuration"],
  children: [
    {
      label: "Operation setup",
      href: "/admin/setup",
      exact: true,
      keywords: ["jar sizes treatments withdrawals thresholds categories policy"],
    },
    {
      label: "Access & integrations",
      href: "/admin",
      exact: true,
      keywords: ["collaborators roles storage ai providers push folio feed"],
    },
    {
      label: "Equipment types",
      href: "/equipment/types",
      keywords: ["bom bill of materials catalog"],
    },
    {
      label: "Varietals",
      href: "/production/varietals",
      keywords: ["honey varietals lot balances"],
    },
  ],
};

/** Every top-level destination Ctrl-K and the `g` chords know about. */
export function allNavItems(): NavItem[] {
  return [...NAV_ITEMS, SETUP_ITEM];
}

/**
 * Context-only destinations that need a real apiary or hive id: the record's
 * tab strip (`RecordHeader`), its sidebar sub-tree and its Ctrl-K commands all
 * read this one list, so a tab cannot exist on one surface and not another.
 * Entries flagged `action` are the record's workflows (voice capture); they
 * are drawn as actions, not tabs.
 */
export function contextualNavRoutes(
  parentHref: string,
  pathname: string,
): NavRoute[] {
  const apiary = pathname.match(/^\/yard\/apiaries\/([^/]+)/)?.[1];
  if (parentHref === "/yard/apiaries" && apiary) {
    const base = `/yard/apiaries/${apiary}`;
    return [
      { label: "Overview", href: `${base}/overview`, exact: true },
      // The bare record URL still opens the map, so the Map tab claims it.
      {
        label: "Map",
        href: `${base}/layout`,
        exact: true,
        matches: [base],
        keywords: ["layout canvas"],
      },
      { label: "Observations", href: `${base}/inspections`, keywords: ["apiary inspections visit notes"] },
      { label: "Flora", href: `${base}/flora`, keywords: ["blooms forage"] },
      { label: "Photos", href: `${base}/photos` },
      { label: "Timeline", href: `${base}/timeline`, keywords: ["yard photo timeline immich"] },
      { label: "Labels", href: `${base}/labels`, keywords: ["print tags qr nfc"] },
      { label: "Bulk record", href: `${base}/bulk`, requiresEdit: true },
      { label: "Record visit", href: `${base}/visit`, requiresEdit: true, action: true },
      {
        label: "Voice walkthrough",
        href: `${base}/visit?scope=batch`,
        requiresEdit: true,
        action: true,
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
        href: `${base}/timeline`,
        exact: true,
        keywords: ["inspections feedings treatments mites splits moves harvests"],
      },
      { label: "Health", href: `${base}/health`, keywords: ["varroa inspections"], exact: true },
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
        action: true,
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

/** The names the rail draws the open records with (null while loading). */
export interface RecordLabels {
  apiary?: string | null;
  hive?: string | null;
}

/**
 * The one row a rail draws for the record it is on: "Lenoir Apiary" under
 * Apiary list, "D1" under Hives. Its tabs and actions belong to the record
 * header (`contextualNavRoutes`), never to the rail — drawn beside the tab
 * strip they were the same fourteen links twice.
 */
export function currentRecordRoute(
  parentHref: string,
  pathname: string,
  labels: RecordLabels = {},
): NavRoute | undefined {
  const apiary = pathname.match(/^\/yard\/apiaries\/([^/]+)/)?.[1];
  if (parentHref === "/yard/apiaries" && apiary) {
    return {
      label: labels.apiary ?? "Current apiary",
      href: `/yard/apiaries/${apiary}`,
      keywords: ["record"],
    };
  }
  const hive = pathname.match(/^\/yard\/hives\/([^/]+)/)?.[1];
  if (parentHref === "/yard/hives" && hive) {
    return {
      label: labels.hive ?? "Current hive",
      href: `/yard/hives/${hive}`,
      keywords: ["record"],
    };
  }
  return undefined;
}

/**
 * The drawn tree under an area: its static children minus the palette-only
 * ones, and under a list page the one record that is open. A record's tab
 * and action routes (`contextualNavRoutes`) stay in Ctrl-K and the record
 * header; they are never rail rows.
 */
export function navRouteChildren(
  route: NavRoute,
  pathname: string,
  isAdmin: boolean,
  canEdit: boolean,
  labels: RecordLabels = {},
): NavRoute[] {
  const staticChildren = (route.children ?? []).filter(
    (child) => !child.paletteOnly,
  );
  return visibleNavRoutes(staticChildren, isAdmin, canEdit).map((child) => {
    const record = currentRecordRoute(child.href, pathname, labels);
    return {
      ...child,
      children: record
        ? [record]
        : child.href === route.href
          ? undefined
          : navRouteChildren(child, pathname, isAdmin, canEdit, labels),
    };
  });
}

/** Backward-compatible name used by top-level navigation callers. */
export function visibleNavItems(items: NavItem[], isAdmin: boolean) {
  return visibleNavRoutes(items, isAdmin);
}

export function routePath(href: string) {
  return href.split("?")[0];
}

function excluded(route: NavRoute, pathname: string) {
  return (
    route.excludes?.some(
      (path) => pathname === path || pathname.startsWith(`${path}/`),
    ) ?? false
  );
}

export function isNavRouteActive(route: NavRoute, currentHref: string): boolean {
  if (
    route.children?.some(
      (child) => !child.alias && isNavRouteActive(child, currentHref),
    )
  ) {
    return true;
  }
  const [pathname, currentQuery = ""] = currentHref.split("?");
  const path = routePath(route.href);
  if (route.exact) {
    if (pathname !== path) return route.matches?.includes(pathname) ?? false;
    const routeQuery = route.href.split("?")[1];
    if (!routeQuery) return true;
    const currentParams = new URLSearchParams(currentQuery);
    const routeParams = new URLSearchParams(routeQuery);
    return Array.from(routeParams).every(
      ([key, value]) => currentParams.get(key) === value,
    );
  }
  if (excluded(route, pathname)) return false;
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

export interface ResolvedNavRoute {
  area: NavItem;
  route: IndexedNavRoute;
}

/**
 * The index entry a pathname belongs to: the most specific route whose path
 * (or `matches` prefix) covers it. This is what gives a page its h1, its
 * `<title>` and its phone disclosure, so a label lives in exactly one place.
 */
export function resolveNavRoute(href: string): ResolvedNavRoute | undefined {
  const [pathname] = href.split("?");
  let best: ResolvedNavRoute | undefined;
  let bestScore = -1;
  for (const area of allNavItems()) {
    for (const route of flattenNavRoutes([area])) {
      if (route.alias) continue;
      const path = routePath(route.href);
      let matchedPath: string | undefined;
      if (pathname === path) matchedPath = path;
      else if (!route.exact && !excluded(route, pathname) && pathname.startsWith(`${path}/`)) {
        matchedPath = path;
      } else if (!excluded(route, pathname)) {
        matchedPath = route.matches?.find(
          (match) => pathname === match || pathname.startsWith(`${match}/`),
        );
      }
      if (!matchedPath) continue;
      const score =
        matchedPath.length * 100 +
        (pathname === path ? 50 : 0) +
        route.breadcrumbs.length;
      if (score > bestScore) {
        bestScore = score;
        best = { area, route };
      }
    }
  }
  return best;
}

/**
 * "Page · Area" for the document title (the root layout appends the brand).
 * The area root alone is just the area ("Today", "Apiaries").
 */
export function navPageTitle(href: string): string | undefined {
  const resolved = resolveNavRoute(href);
  if (!resolved) return undefined;
  const { area, route } = resolved;
  if (route.breadcrumbs.length === 1 || route.label === area.label) {
    return area.label;
  }
  return `${route.label} · ${area.label}`;
}

/**
 * Order the bottom bar fills its four fixed slots from; the fifth slot is
 * always More. More itself renders the complete folded route tree plus Setup
 * and the account link.
 *
 * One entry per area, so the phone bar can never be a different information
 * architecture from the desktop rail: an admin gets Today / Apiaries / Stock
 * / Sales plus More, and a viewer or editor gets Today / Apiaries / Insights
 * plus More. Apiaries is pinned second for every role — it is where Saturday
 * starts — and no admin-only area can push it off the bar.
 */
const MOBILE_PRIORITY = ["/today", "/yard", "/stock", "/sales", "/insights"];
const MOBILE_SLOTS = 4;

export function primaryMobileItems(isAdmin: boolean): NavItem[] {
  const visible = visibleNavItems(NAV_ITEMS, isAdmin);
  return MOBILE_PRIORITY.map((href) =>
    visible.find((item) => item.href === href),
  )
    .filter((item): item is NavItem => item != null)
    .slice(0, MOBILE_SLOTS);
}

export function overflowMobileItems(isAdmin: boolean): NavItem[] {
  const pinned = new Set(primaryMobileItems(isAdmin).map((item) => item.href));
  return visibleNavItems(allNavItems(), isAdmin).filter(
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
