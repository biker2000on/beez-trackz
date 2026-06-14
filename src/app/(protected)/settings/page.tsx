import { getApiaries } from "@/actions/apiaries";
import { getAISettings } from "@/actions/ai-settings";
import { getJarSizes } from "@/actions/jar-sizes";
import { getPreferences } from "@/actions/preferences";
import { Cpu, Download, GlassWater, SlidersHorizontal, Upload } from "lucide-react";
import { AIProviderConfig } from "@/components/settings/ai-provider-config";
import { ImportRecordsSection } from "@/components/settings/import-records-section";
import { JarSizeSettings } from "@/components/settings/jar-size-settings";
import { PreferencesForm } from "@/components/settings/preferences-form";
import { SettingsSection } from "@/components/settings/settings-section";
import { InstallAppSetting } from "@/components/pwa/install-app-setting";

export default async function SettingsPage() {
  const [preferences, apiaries, aiSettings, jarSizes] = await Promise.all([
    getPreferences(),
    getApiaries(),
    getAISettings(),
    getJarSizes(true),
  ]);

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage app configuration without leaving this page.
        </p>
      </div>

      <div className="space-y-3">
        <SettingsSection
          title="Preferences"
          description="Units, default apiary, and display settings"
          icon={SlidersHorizontal}
          defaultOpen
        >
          <PreferencesForm
            preferences={preferences}
            apiaries={apiaries.map((a) => ({ id: a.id, name: a.name }))}
          />
        </SettingsSection>

        <SettingsSection
          title="AI Configuration"
          description="Configure providers for transcription, recommendations, and image analysis"
          icon={Cpu}
        >
          <AIProviderConfig initialSettings={aiSettings} />
        </SettingsSection>

        <SettingsSection
          title="Jar Sizes"
          description="Configure honey jar sizes, weights, and default prices"
          icon={GlassWater}
        >
          <JarSizeSettings initialSizes={jarSizes} />
        </SettingsSection>

        <SettingsSection
          title="Import Records"
          description="Import old beekeeping records from files or transcripts"
          icon={Upload}
        >
          <ImportRecordsSection />
        </SettingsSection>

        <SettingsSection
          title="Install App"
          description="Add Beez Trackz to this device"
          icon={Download}
        >
          <InstallAppSetting />
        </SettingsSection>
      </div>
    </div>
  );
}
