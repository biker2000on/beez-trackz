"use client";

import { KeyRound, Lock, MonitorSmartphone, SlidersHorizontal } from "lucide-react";

import { useBrand } from "@/components/brand-provider";
import { MyAccessSection } from "@/features/access/access-section";
import { InstallSection } from "@/features/settings/install-section";
import { PasswordSection } from "@/features/settings/password-section";
import { SettingsSection } from "@/features/settings/settings-section";

import { MePreferencesForm } from "./preferences-form";

/**
 * `/me` — My Preferences (design 2026-09-03 §6.1).
 *
 * Every authenticated user gets this, admin or not: it holds only what
 * belongs to the account looking at it. Nothing here is operation policy, so
 * nothing here can be changed by one user on another's behalf — the data
 * lives in `user_preferences`, keyed by `app_users.id` (§6.4).
 */
export function MeView() {
  const brand = useBrand();

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">My preferences</h1>
        <p className="text-sm text-muted-foreground">
          Your display settings, your sign-in, your access and tokens. Yours
          only — changing them changes nothing for anyone else.
        </p>
      </div>
      <SettingsSection
        title="Preferences"
        description="Theme, default apiary, and display formats."
        icon={SlidersHorizontal}
        anchor="preferences"
      >
        <MePreferencesForm />
      </SettingsSection>
      <SettingsSection
        title="Password login"
        description="Use your SSO email and a password, or keep signing in with SSO."
        icon={Lock}
        anchor="password"
        defaultOpen={false}
      >
        <PasswordSection />
      </SettingsSection>
      <SettingsSection
        title="Your access and API tokens"
        description="The apiaries you can reach, your API tokens, and your MCP connection."
        icon={KeyRound}
        anchor="tokens"
        defaultOpen={false}
      >
        <MyAccessSection />
      </SettingsSection>
      <SettingsSection
        title="Install app"
        description={`Add ${brand.displayName} to your home screen.`}
        icon={MonitorSmartphone}
        anchor="install"
        defaultOpen={false}
      >
        <InstallSection />
      </SettingsSection>
    </div>
  );
}
