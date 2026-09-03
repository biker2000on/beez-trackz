"use client";

import Link from "next/link";
import { ArrowRight, Boxes, FlaskConical, Package, QrCode } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";

const PRODUCTION_AREAS = [
  {
    href: "/production/harvests",
    title: "Harvests",
    description: "Record extraction sessions and individual hive harvests.",
    icon: Boxes,
  },
  {
    href: "/production/jars",
    title: "Jars",
    description: "Bottle bulk honey and keep packaged stock accurate.",
    icon: Package,
  },
  {
    href: "/production/lots",
    title: "Lots & QR",
    description: "Manage traceable lots, jar serials, labels, and lookup.",
    icon: QrCode,
  },
  {
    href: "/production/products",
    title: "Hive products",
    description: "Catalog, propolis harvests, and creamed / hot / mead / tincture batches.",
    icon: FlaskConical,
  },
] as const;

export function ProductionOverview() {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Production</h1>
        <p className="text-sm text-muted-foreground">
          Move honey from the hive through extraction, bottling, other hive
          products, and a traceable finished lot.
        </p>
      </div>

      <ul className="grid gap-3 md:grid-cols-2">
        {PRODUCTION_AREAS.map((area) => {
          const Icon = area.icon;
          return (
            <li key={area.href}>
              <Card className="h-full transition-colors hover:border-primary/50">
                <CardContent className="p-4">
                  <Link
                    href={area.href}
                    className="flex h-full items-start gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Icon className="mt-0.5 size-5 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{area.title}</span>
                      <span className="mt-1 block text-sm text-muted-foreground">
                        {area.description}
                      </span>
                    </span>
                    <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
                  </Link>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
