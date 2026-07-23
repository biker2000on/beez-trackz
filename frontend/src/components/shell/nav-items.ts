import {
  Crown,
  Droplets,
  Hexagon,
  LayoutDashboard,
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
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", shortLabel: "Home", href: "/dashboard", icon: LayoutDashboard, shortcutKey: "d" },
  { label: "Apiaries", shortLabel: "Apiaries", href: "/apiaries", icon: MapPin, shortcutKey: "a" },
  { label: "Hives", shortLabel: "Hives", href: "/hives", icon: Hexagon, shortcutKey: "h" },
  { label: "Queens", shortLabel: "Queens", href: "/genealogy", icon: Crown, shortcutKey: "q" },
  { label: "Recommendations", shortLabel: "Recs", href: "/recommendations", icon: Sparkles, shortcutKey: "r" },
  { label: "Honey", shortLabel: "Honey", href: "/harvest", icon: Droplets, shortcutKey: "y" },
  { label: "Inventory", shortLabel: "Gear", href: "/inventory", icon: Package, shortcutKey: "i" },
  { label: "Settings", shortLabel: "Settings", href: "/settings", icon: Settings, shortcutKey: "s" },
];

/** Items shown in the mobile bottom bar (space for 5). */
export const MOBILE_NAV_ITEMS = [
  NAV_ITEMS[0], // Dashboard
  NAV_ITEMS[1], // Apiaries
  NAV_ITEMS[2], // Hives
  NAV_ITEMS[5], // Honey
  NAV_ITEMS[7], // Settings
];
