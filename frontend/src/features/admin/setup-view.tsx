"use client";

import { Milk, ShieldAlert, SlidersHorizontal, Tags } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { JarSizesSection } from "@/features/settings/jar-sizes-section";
import { SettingsSection } from "@/features/settings/settings-section";
import { TreatmentProductsSection } from "@/features/settings/treatment-products-section";

import { AdminGate } from "./admin-gate";
import { FinanceCategoriesSection } from "./finance-categories-section";
import { OperationPolicyForm } from "./policy-form";

/**
 * `/admin/setup` — Operation Setup (design 2026-09-03 §6.2).
 *
 * The operational catalogs and policies Yard, Production, Sales and Equipment
 * work from, each reachable by a contextual "manage" link from the workspace
 * that consumes it. It is deliberately not the same page as Admin and
 * Integrations: nothing here is a credential, and everything here is a choice
 * about how the operation runs. The other Setup pages (Access &
 * integrations, Equipment types, Varietals) are the rail's Setup sub-tree and
 * the phone disclosure, not cards repeated here.
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
            title="Thresholds and visit labor"
            description="Varroa and moisture action levels, and whether the Visit queue offers a start/stop timer."
            icon={SlidersHorizontal}
            anchor="thresholds"
            defaultOpen={false}
          >
            <OperationPolicyForm />
          </SettingsSection>
        </div>
      </AdminGate>
    </div>
  );
}
