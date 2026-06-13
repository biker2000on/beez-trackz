import { Home, TreePine, Bug, Crown, Bell, Droplets, Boxes, Settings } from "lucide-react";

/**
 * `label` is used by the desktop sidebar and the shortcut help dialog.
 * `short` is the compact label for the mobile bottom nav, where eight
 * items must share a narrow viewport.
 */
export const navItems = [
  { label: "Home", short: "Home", href: "/dashboard", icon: Home },
  { label: "Apiaries", short: "Yards", href: "/apiaries", icon: TreePine },
  { label: "Hives", short: "Hives", href: "/hives", icon: Bug },
  { label: "Queens", short: "Queens", href: "/genealogy", icon: Crown },
  { label: "Recommendations", short: "Recs", href: "/recommendations", icon: Bell },
  { label: "Honey", short: "Honey", href: "/harvest", icon: Droplets },
  { label: "Inventory", short: "Gear", href: "/inventory", icon: Boxes },
  { label: "Settings", short: "Settings", href: "/settings", icon: Settings },
] as const;
