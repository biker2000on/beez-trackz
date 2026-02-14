import { Home, TreePine, Bug, Droplets, Settings } from "lucide-react";

export const navItems = [
  { label: "Home", href: "/dashboard", icon: Home },
  { label: "Apiaries", href: "/apiaries", icon: TreePine },
  { label: "Hives", href: "/hives", icon: Bug },
  { label: "Harvest", href: "/harvest", icon: Droplets },
  { label: "Settings", href: "/settings", icon: Settings },
] as const;
