import { Home, TreePine, Bug, Crown, Bell, Droplets, Boxes, Settings } from "lucide-react";

export const navItems = [
  { label: "Home", href: "/dashboard", icon: Home },
  { label: "Apiaries", href: "/apiaries", icon: TreePine },
  { label: "Hives", href: "/hives", icon: Bug },
  { label: "Queens", href: "/genealogy", icon: Crown },
  { label: "Recommendations", href: "/recommendations", icon: Bell },
  { label: "Honey", href: "/harvest", icon: Droplets },
  { label: "Inventory", href: "/inventory", icon: Boxes },
  { label: "Settings", href: "/settings", icon: Settings },
] as const;
