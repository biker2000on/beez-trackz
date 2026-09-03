"use client";

import Link from "next/link";
import { ArrowRight, Milk, Package, ShieldAlert, SlidersHorizontal, Wheat } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { JarSizesSection } from "@/features/settings/jar-sizes-section";
import { SettingsSection } from "@/features/settings/settings-section";
import { TreatmentProductsSection } from "@/features/settings/treatment-products-section";

import { AdminGate } from "./admin-gate";
import { OperationPolicyForm } from "./policy-form";

/** Catalogs whose editor is owned by the workspace that uses them. */
const ELSEWHERE = [
  {
    href: "/production/varietals",
    label: "Honey varietals",
    description: "Named in Production, where lots are given one.",
    icon: Wheat,
  },
  {
    href: "/equipment/types",
    label: "Equipment types and BOMs",
    description: "Defined in Equipment, beside the stock they count.",
    icon: Package,
  },
];

/**
 * `/admin/setup` — Operation Setup (design 2026-09-03 §6.2).
 *
 * The operational catalogs and policies Yard, Production, Sales and Equipment
 * work from, each reachable by a contextual "manage" link from the workspace
 * that consumes it. It is deliberately not the same page as Admin and
 * Integrations: nothing here is a credential, and everything here is a choice
 * about how the operation runs.
 */
export function OperationSetupView() {
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Operation setup</h1>
        <p className="text-sm text-muted-foreground">
          Jar sizes, treatment withdrawals and the thresholds the yard queue
          works from. Integrations and access live under Admin.
        </p>
      </div>
      <AdminGate>
        <div className="grid gap-4">
          <SettingsSection
            title="Jar sizes"
            description="Container catalog the honey ledger jars, counts and sells in."
            icon={Milk}
            anchor="jar-sizes"
          >
            <JarSizesSection />
          </SettingsSection>
          <SettingsSection
            title="Treatment withdrawals"
            description="Days after date-off before honey from that hive can be extracted or sold."
            icon={ShieldAlert}
            anchor="treatment-withdrawals"
            defaultOpen={false}
          >
            <TreatmentProductsSection />
          </SettingsSection>
          <SettingsSection
            title="Thresholds and yard-visit labor"
            description="Varroa and moisture action levels, and whether the yard queue offers a start/stop timer."
            icon={SlidersHorizontal}
            anchor="thresholds"
            defaultOpen={false}
          >
            <OperationPolicyForm />
          </SettingsSection>

          <Card>
            <CardContent className="grid gap-3 p-5">
              <div>
                <h2 className="font-semibold">Catalogs owned elsewhere</h2>
                <p className="text-sm text-muted-foreground">
                  One editor each, in the area that uses them.
                </p>
              </div>
              <ul className="grid gap-2">
                {ELSEWHERE.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="flex items-start justify-between gap-3 rounded-md border p-3 transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="flex min-w-0 items-start gap-3">
                        <item.icon className="mt-0.5 size-4 shrink-0 text-primary" />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">
                            {item.label}
                          </span>
                          <span className="block text-sm text-muted-foreground">
                            {item.description}
                          </span>
                        </span>
                      </span>
                      <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </AdminGate>
    </div>
  );
}
