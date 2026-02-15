import { Home, TreePine, Bug, Crown, Droplets, Settings } from "lucide-react";

export const navItems = [
  { label: "Home", href: "/dashboard", icon: Home },
  { label: "Apiaries", href: "/apiaries", icon: TreePine },
  { label: "Hives", href: "/hives", icon: Bug },
  { label: "Queens", href: "/genealogy", icon: Crown },
  { label: "Harvest", href: "/harvest", icon: Droplets },
  { label: "Settings", href: "/settings", icon: Settings },
] as const;
