import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Boxes, Cpu, SlidersHorizontal, Upload, GlassWater } from "lucide-react";

const settingsLinks = [
  {
    title: "Equipment Inventory",
    description: "Manage hive bodies, supers, covers, and accessories",
    href: "/settings/equipment",
    icon: Boxes,
  },
  {
    title: "AI Configuration",
    description: "Configure AI assistant recommendations",
    href: "/settings/ai",
    icon: Cpu,
  },
  {
    title: "Preferences",
    description: "Units, notifications, and display settings",
    href: "/settings/preferences",
    icon: SlidersHorizontal,
  },
  {
    title: "Jar Sizes",
    description: "Configure honey jar sizes and weights",
    href: "/settings/jar-sizes",
    icon: GlassWater,
  },
  {
    title: "Import Records",
    description: "Import old beekeeping records from any format",
    href: "/settings/import",
    icon: Upload,
  },
];

export default function SettingsPage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {settingsLinks.map((item) => (
          <Link key={item.href} href={item.href}>
            <Card className="hover:bg-accent/50 transition-colors cursor-pointer h-full">
              <CardHeader className="flex flex-row items-center gap-3 pb-2">
                <item.icon className="h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-base">{item.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <CardDescription>{item.description}</CardDescription>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
