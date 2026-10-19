"use client";

import Link from "next/link";
import { ArrowRight, Milk, Package, ShieldAlert, SlidersHorizontal, Tags, Wheat } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { JarSizesSection } from "@/features/settings/jar-sizes-section";
import { SettingsSection } from "@/features/settings/settings-section";
import { TreatmentProductsSection } from "@/features/settings/treatment-products-section";

import { AdminGate } from "./admin-gate";
import { FinanceCategoriesSection } from "./finance-categories-section";
import { OperationPolicyForm } from "./policy-form";

/**
 * The other Setup pages (`SETUP_ITEM` in nav-items): catalogs with an editor
 * of their own, reached from here as well as from the sidebar.
 */
const SETUP_PAGES = [
  {
    href: "/production/varietals",
    label: "Varietals",
    description: "The honey varietals lots are named for, with their balances.",
    icon: Wheat,
  },
  {
    href: "/equipment/types",
    label: "Equipment types",
    description: "The catalog Equipment counts against, with bills of materials.",
    icon: Package,
  },
];

/** A stable element id for a setup link: "/equipment/types" -> "setup-equipment-types". */
function labelId(href: string): string {
  return `setup-${href.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`;
}

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
      <PageHeader subtitle="Set the jar sizes, treatment withdrawals, categories and thresholds the operation runs on." />
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
            title="Expense and income categories"
            description="The categories expenses and imported income are filed under, and that the Folio mapping and reports group by."
            icon={Tags}
            anchor="finance-categories"
            defaultOpen={false}
          >
            <FinanceCategoriesSection />
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
                <h2 className="font-semibold">More setup</h2>
                <p className="text-sm text-muted-foreground">
                  Catalogs with a page of their own.
                </p>
              </div>
              <ul className="grid gap-2">
                {SETUP_PAGES.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-labelledby={`${labelId(item.href)}-label`}
                      aria-describedby={`${labelId(item.href)}-desc`}
                      className="flex items-start justify-between gap-3 rounded-md border p-3 transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="flex min-w-0 items-start gap-3">
                        <item.icon className="mt-0.5 size-4 shrink-0 text-primary" />
                        <span className="min-w-0">
                          <span
                            id={`${labelId(item.href)}-label`}
                            className="block text-sm font-medium"
                          >
                            {item.label}
                          </span>
                          <span
                            id={`${labelId(item.href)}-desc`}
                            className="block text-sm text-muted-foreground"
                          >
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
