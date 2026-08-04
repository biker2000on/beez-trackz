import {
  Crown,
  Droplets,
  Hexagon,
  LayoutDashboard,
  ChartNoAxesCombined,
  MapPin,
  Package,
  Settings,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  /** Short label for the mobile bottom nav. */
  shortLabel: string;
  href: string;
  icon: LucideIcon;
  /** Key used in the `g` + key navigation sequence. */
  shortcutKey: string;
  adminOnly?: boolean;
}

/**
 * Every top-level destination, in sidebar order. Labels and routes agree:
 * "Queens" goes to `/queens` (`/genealogy` redirects there).
 *
 * The Honey module keeps the `/harvest` path because `/honey/[slug]` is the
 * public harvest-lot story route; "Harvests" is a subsection of Honey at
 * `/harvest/harvests`.
 */
export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", shortLabel: "Home", href: "/dashboard", icon: LayoutDashboard, shortcutKey: "d" },
  { label: "Apiaries", shortLabel: "Yards", href: "/apiaries", icon: MapPin, shortcutKey: "a" },
  { label: "Hives", shortLabel: "Hives", href: "/hives", icon: Hexagon, shortcutKey: "h" },
  { label: "Honey", shortLabel: "Honey", href: "/harvest", icon: Droplets, shortcutKey: "y", adminOnly: true },
  { label: "Inventory", shortLabel: "Gear", href: "/inventory", icon: Package, shortcutKey: "i", adminOnly: true },
  { label: "Reports", shortLabel: "Reports", href: "/reports", icon: ChartNoAxesCombined, shortcutKey: "o" },
  { label: "Queens", shortLabel: "Queens", href: "/queens", icon: Crown, shortcutKey: "q" },
  { label: "Recommendations", shortLabel: "Recs", href: "/recommendations", icon: Sparkles, shortcutKey: "r" },
  { label: "Settings", shortLabel: "Settings", href: "/settings", icon: Settings, shortcutKey: "s" },
];

/**
 * Order the bottom bar fills its four fixed slots from; the fifth slot is
 * always "More", which opens a sheet with every remaining destination. The
 * old bar silently dropped four of nine destinations — and a different four
 * per role — leaving Inventory unreachable in the field.
 */
const MOBILE_PRIORITY = [
  "/apiaries",
  "/hives",
  "/harvest",
  "/inventory",
  "/reports",
  "/recommendations",
  "/queens",
  "/dashboard",
  "/settings",
];

export function visibleNavItems(items: NavItem[], isAdmin: boolean) {
  return items.filter((item) => isAdmin || !item.adminOnly);
}

/** The four items pinned to the bottom bar for this role. */
export function primaryMobileItems(isAdmin: boolean): NavItem[] {
  const visible = visibleNavItems(NAV_ITEMS, isAdmin);
  return MOBILE_PRIORITY.map((href) =>
    visible.find((item) => item.href === href),
  )
    .filter((item): item is NavItem => item != null)
    .slice(0, 4);
}

/** Everything not pinned, shown in the "More" sheet. */
export function overflowMobileItems(isAdmin: boolean): NavItem[] {
  const pinned = new Set(primaryMobileItems(isAdmin).map((item) => item.href));
  return visibleNavItems(NAV_ITEMS, isAdmin).filter(
    (item) => !pinned.has(item.href),
  );
}
