"use client";

import { Bot, Milk, MonitorSmartphone, SlidersHorizontal } from "lucide-react";

import { AISection } from "./ai-section";
import { InstallSection } from "./install-section";
import { JarSizesSection } from "./jar-sizes-section";
import { PreferencesSection } from "./preferences-section";
import { SettingsSection } from "./settings-section";

export function SettingsView() {
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Preferences, AI providers, jar sizes, and app install.
        </p>
      </div>
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
