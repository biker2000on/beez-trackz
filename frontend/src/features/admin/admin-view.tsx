"use client";

import Link from "next/link";
import {
  ArrowRight,
  Bell,
  BookOpenCheck,
  Bot,
  Images,
  KeyRound,
  SlidersHorizontal,
} from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
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
 * a credential or govern who may do what. The operational catalogs are one
 * click away at `/admin/setup`; per-user display settings are on `/me` and
 * are not editable from here at all.
 */
export function AdminView() {
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4">
      <PageHeader subtitle="Manage who can do what, and connect photo storage, AI, phone push and the Folio feed." />

      <Card>
        <CardContent className="p-4">
          <Link
            href="/admin/setup"
            className="flex items-start justify-between gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex min-w-0 items-start gap-3">
              <SlidersHorizontal className="mt-0.5 size-5 shrink-0 text-primary" />
              <span className="min-w-0">
                <span className="block font-medium">Operation setup</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">
                  Jar sizes, treatment withdrawals, thresholds and the
                  yard-visit labor flag.
                </span>
              </span>
            </span>
            <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
          </Link>
        </CardContent>
      </Card>

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
