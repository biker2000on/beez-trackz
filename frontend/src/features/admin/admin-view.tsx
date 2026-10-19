"use client";

import { Bell, BookOpenCheck, Bot, Images, KeyRound } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { CollaboratorsSection } from "@/features/access/access-section";
import { AISection } from "@/features/settings/ai-section";
import { SettingsSection } from "@/features/settings/settings-section";
import { StorageSection } from "@/features/settings/storage-section";

import { AdminGate } from "./admin-gate";
import { GnuCashSection } from "./gnucash-section";
import { NtfySection } from "./ntfy-section";

/**
 * `/admin` — Admin and Integrations (design 2026-09-03 §6.3).
 *
 * Access, media, AI, notifications and the Folio feed: the things that need
 * a credential or govern who may do what. The operational catalogs are the
 * sibling page `/admin/setup`, reached from the rail's Setup sub-tree and the
 * phone disclosure; per-user display settings are on `/me` and are not
 * editable from here at all.
 */
export function AdminView() {
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4">
      <PageHeader subtitle="Manage who can do what, and connect photo storage, AI, phone push and the Folio feed." />

      <AdminGate>
        <div className="grid gap-4">
          <SettingsSection
            title="Users, access, and API"
            description="Apiary collaborators and viewer/editor roles. Your own tokens are on My preferences."
            icon={KeyRound}
            anchor="access"
          >
            <CollaboratorsSection />
          </SettingsSection>
          <SettingsSection
            title="AI configuration"
            description="Provider keys, connection tests, and per-task models."
            icon={Bot}
            anchor="ai"
            defaultOpen={false}
          >
            <AISection />
          </SettingsSection>
          <SettingsSection
            title="Photo storage and media health"
            description="Default original backend, Immich health, and photo counts."
            icon={Images}
            anchor="storage"
            defaultOpen={false}
          >
            <StorageSection />
          </SettingsSection>
          <SettingsSection
            title="Phone push (ntfy)"
            description="Optional webhook for mite checks, empty feeders, treatment off-dates, and flow start."
            icon={Bell}
            anchor="ntfy"
            defaultOpen={false}
          >
            <NtfySection />
          </SettingsSection>
          <SettingsSection
            title="Folio sync"
            description="Credentials, book and account mapping. The reconciliation report is under Insights."
            icon={BookOpenCheck}
            anchor="gnucash"
            defaultOpen={false}
          >
            <GnuCashSection />
          </SettingsSection>
        </div>
      </AdminGate>
    </div>
  );
}
