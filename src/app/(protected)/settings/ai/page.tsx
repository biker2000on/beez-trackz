import { getAISettings } from "@/actions/ai-settings";
import { AIProviderConfig } from "@/components/settings/ai-provider-config";

export default async function AISettingsPage() {
  const settings = await getAISettings();

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-2">AI Configuration</h1>
      <p className="text-muted-foreground mb-6">
        Configure AI providers for transcription, recommendations, and image analysis
      </p>
      <AIProviderConfig initialSettings={settings} />
    </div>
  );
}
