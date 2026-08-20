"use client";

import {
  Bell,
  Bot,
  ClipboardList,
  Images,
  KeyRound,
  Lock,
  Milk,
  MonitorSmartphone,
  SlidersHorizontal,
  Timer,
} from "lucide-react";

import { AccessSection } from "@/features/access/access-section";
import { useAccessProfile } from "@/features/access/api";
import { AISection } from "./ai-section";
import { ComplianceSection } from "./compliance-section";
import { InstallSection } from "./install-section";
import { JarSizesSection } from "./jar-sizes-section";
import { LaborControl } from "./labor-control";
import { NtfySection } from "./ntfy-section";
import { PasswordSection } from "./password-section";
import { PreferencesSection } from "./preferences-section";
import { SettingsSection } from "./settings-section";
import { StorageSection } from "./storage-section";
import { TreatmentProductsSection } from "./treatment-products-section";

export function SettingsView() {
  const profile = useAccessProfile();
  const isAdmin = profile.data?.isAdmin === true;
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Preferences, sign-in, AI providers, jar sizes, ntfy, labor, and app
          install.
        </p>
      </div>
      <SettingsSection
        title="Password login"
        description="Use your SSO email and a password, or keep signing in with SSO."
        icon={Lock}
      >
        <PasswordSection />
      </SettingsSection>
      {isAdmin ? (
        <>
          <SettingsSection
            title="Preferences"
            description="Theme, default apiary, and display formats."
            icon={SlidersHorizontal}
          >
            <PreferencesSection />
          </SettingsSection>
          <SettingsSection
            title="AI configuration"
            description="Provider keys, connection tests, and per-task models."
            icon={Bot}
            defaultOpen={false}
          >
            <AISection />
          </SettingsSection>
          <SettingsSection
            title="Jar sizes"
            description="Container catalog used by the honey ledger."
            icon={Milk}
            defaultOpen={false}
          >
            <JarSizesSection />
          </SettingsSection>
          <SettingsSection
            title="Treatment withdrawals"
            description="Days after date-off before honey from that hive can be extracted or sold."
            icon={SlidersHorizontal}
            defaultOpen={false}
          >
            <TreatmentProductsSection />
          </SettingsSection>
          <SettingsSection
            title="Photo storage"
            description="Default original backend, Immich health, and photo counts."
            icon={Images}
            defaultOpen={false}
          >
            <StorageSection />
          </SettingsSection>
          <SettingsSection
            title="Phone push (ntfy)"
            description="Optional webhook for mite checks, empty feeders, treatment off-dates, and flow start."
            icon={Bell}
            defaultOpen={false}
          >
            <NtfySection />
          </SettingsSection>
          <SettingsSection
            title="Yard-visit labor"
            description="Optional start/stop timer for Saturday minutes. Off until enabled in Preferences."
            icon={Timer}
            defaultOpen={false}
          >
            <LaborControl />
          </SettingsSection>
          <SettingsSection
            title="Compliance packet"
            description="Authenticated export: hives, treatments, lots, sales, withdrawal windows."
            icon={ClipboardList}
            defaultOpen={false}
          >
            <ComplianceSection />
          </SettingsSection>
        </>
      ) : null}
      <SettingsSection
        title="Users, access, and API"
        description={
          isAdmin
            ? "Apiary collaborators, viewer/editor roles, API tokens, and MCP."
            : "Your apiary access, API tokens, and MCP connection."
        }
        icon={KeyRound}
        defaultOpen={isAdmin}
      >
        <AccessSection />
      </SettingsSection>
      <SettingsSection
        title="Install app"
        description="Add Beez Trackz to your home screen."
        icon={MonitorSmartphone}
        defaultOpen={false}
      >
        <InstallSection />
      </SettingsSection>
    </div>
  );
}
