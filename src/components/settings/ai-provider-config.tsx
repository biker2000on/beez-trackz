"use client";

import { useActionState, useState, useTransition } from "react";
import { updateAISettings, testAIConnection, getOllamaModels } from "@/actions/ai-settings";
import type { AIProviderConfig as AIProviderConfigType } from "@/lib/ai/types";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";

interface AIProviderConfigProps {
  initialSettings: AIProviderConfigType | null;
}

export function AIProviderConfig({ initialSettings }: AIProviderConfigProps) {
  const [state, formAction, isPending] = useActionState(updateAISettings, null);
  const [testResults, setTestResults] = useState<Record<string, { success?: boolean; message?: string; error?: string }>>({});
  const [isPendingTest, startTestTransition] = useTransition();
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);

  const [formState, setFormState] = useState({
    transcriptionProvider: initialSettings?.transcription.provider || "gemini",
    transcriptionModel: initialSettings?.transcription.model || "",
    recommendationsProvider: initialSettings?.recommendations.provider || "claude",
    recommendationsModel: initialSettings?.recommendations.model || "",
    imageAnalysisProvider: initialSettings?.imageAnalysis.provider || "claude",
    imageAnalysisModel: initialSettings?.imageAnalysis.model || "",
    anthropicKey: initialSettings?.apiKeys.anthropic || "",
    googleKey: initialSettings?.apiKeys.google || "",
    ollamaUrl: initialSettings?.apiKeys.ollamaUrl || "http://localhost:11434",
  });

  const handleTestConnection = async (provider: string) => {
    let apiKey = "";

    if (provider === "claude") {
      apiKey = formState.anthropicKey;
    } else if (provider === "gemini") {
      apiKey = formState.googleKey;
    } else if (provider === "ollama") {
      apiKey = formState.ollamaUrl;
    }

    startTestTransition(async () => {
      const result = await testAIConnection(provider, apiKey);
      setTestResults((prev) => ({ ...prev, [provider]: result }));
    });
  };

  return (
    <form action={formAction} className="space-y-6">
      {state?.error && (
        <p className="text-destructive text-sm mb-4 flex items-center gap-2">
          <XCircle className="h-4 w-4" />
          {state.error}
        </p>
      )}

      {state?.success && (
        <p className="text-green-600 text-sm mb-4 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" />
          AI settings saved successfully
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>API Keys</CardTitle>
          <CardDescription>Configure API keys for AI providers</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="anthropicKey">Anthropic API Key (Claude)</Label>
            <div className="flex gap-2">
              <Input
                id="anthropicKey"
                name="anthropicKey"
                type="password"
                placeholder="sk-ant-..."
                value={formState.anthropicKey}
                onChange={(e) => setFormState({ ...formState, anthropicKey: e.target.value })}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => handleTestConnection("claude")}
                disabled={isPendingTest || !formState.anthropicKey}
              >
                {isPendingTest ? <Loader2 className="h-4 w-4 animate-spin" /> : "Test"}
              </Button>
            </div>
            {testResults.claude?.success && (
              <p className="text-sm text-green-600 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                {testResults.claude.message}
              </p>
            )}
            {testResults.claude?.error && (
              <p className="text-sm text-red-600 flex items-center gap-1">
                <XCircle className="h-3 w-3" />
                {testResults.claude.error}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="googleKey">Google AI API Key (Gemini)</Label>
            <div className="flex gap-2">
              <Input
                id="googleKey"
                name="googleKey"
                type="password"
                placeholder="AIza..."
                value={formState.googleKey}
                onChange={(e) => setFormState({ ...formState, googleKey: e.target.value })}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => handleTestConnection("gemini")}
                disabled={isPendingTest || !formState.googleKey}
              >
                {isPendingTest ? <Loader2 className="h-4 w-4 animate-spin" /> : "Test"}
              </Button>
            </div>
            {testResults.gemini?.success && (
              <p className="text-sm text-green-600 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                {testResults.gemini.message}
              </p>
            )}
            {testResults.gemini?.error && (
              <p className="text-sm text-red-600 flex items-center gap-1">
                <XCircle className="h-3 w-3" />
                {testResults.gemini.error}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="ollamaUrl">Ollama URL</Label>
            <div className="flex gap-2">
              <Input
                id="ollamaUrl"
                name="ollamaUrl"
                type="text"
                placeholder="http://localhost:11434"
                value={formState.ollamaUrl}
                onChange={(e) => setFormState({ ...formState, ollamaUrl: e.target.value })}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => handleTestConnection("ollama")}
                disabled={isPendingTest || !formState.ollamaUrl}
              >
                {isPendingTest ? <Loader2 className="h-4 w-4 animate-spin" /> : "Test"}
              </Button>
            </div>
            {testResults.ollama?.success && (
              <p className="text-sm text-green-600 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                {testResults.ollama.message}
              </p>
            )}
            {testResults.ollama?.error && (
              <p className="text-sm text-red-600 flex items-center gap-1">
                <XCircle className="h-3 w-3" />
                {testResults.ollama.error}
              </p>
            )}
            <div className="flex gap-2 mt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  setIsDiscovering(true);
                  try {
                    const models = await getOllamaModels(formState.ollamaUrl);
                    setOllamaModels(models);
                  } catch {
                    setOllamaModels([]);
                  } finally {
                    setIsDiscovering(false);
                  }
                }}
                disabled={isDiscovering || !formState.ollamaUrl}
              >
                {isDiscovering ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                Discover Models
              </Button>
              {ollamaModels.length > 0 && (
                <span className="text-sm text-muted-foreground self-center">
                  {ollamaModels.length} model{ollamaModels.length !== 1 ? "s" : ""} found
                </span>
              )}
            </div>
            {ollamaModels.length > 0 && (
              <div className="mt-2">
                <p className="text-xs text-muted-foreground mb-1">Available models:</p>
                <div className="flex flex-wrap gap-1">
                  {ollamaModels.map((model) => (
                    <span key={model} className="text-xs bg-secondary px-2 py-0.5 rounded">
                      {model}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Task Providers</CardTitle>
          <CardDescription>Choose which AI provider to use for each task</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="transcriptionProvider">Transcription Provider</Label>
            <Select
              name="transcriptionProvider"
              value={formState.transcriptionProvider}
              onValueChange={(value) => setFormState({ ...formState, transcriptionProvider: value })}
            >
              <SelectTrigger id="transcriptionProvider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude (Anthropic)</SelectItem>
                <SelectItem value="gemini">Gemini (Google)</SelectItem>
                <SelectItem value="ollama">Ollama (Local)</SelectItem>
              </SelectContent>
            </Select>
            {formState.transcriptionProvider === "ollama" && ollamaModels.length > 0 ? (
              <Select
                name="transcriptionModel"
                value={formState.transcriptionModel}
                onValueChange={(value) => setFormState({ ...formState, transcriptionModel: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {ollamaModels.map((model) => (
                    <SelectItem key={model} value={model}>{model}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                name="transcriptionModel"
                placeholder="Optional: model name override"
                value={formState.transcriptionModel}
                onChange={(e) => setFormState({ ...formState, transcriptionModel: e.target.value })}
              />
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="recommendationsProvider">Recommendations Provider</Label>
            <Select
              name="recommendationsProvider"
              value={formState.recommendationsProvider}
              onValueChange={(value) => setFormState({ ...formState, recommendationsProvider: value })}
            >
              <SelectTrigger id="recommendationsProvider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude (Anthropic)</SelectItem>
                <SelectItem value="gemini">Gemini (Google)</SelectItem>
                <SelectItem value="ollama">Ollama (Local)</SelectItem>
              </SelectContent>
            </Select>
            {formState.recommendationsProvider === "ollama" && ollamaModels.length > 0 ? (
              <Select
                name="recommendationsModel"
                value={formState.recommendationsModel}
                onValueChange={(value) => setFormState({ ...formState, recommendationsModel: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {ollamaModels.map((model) => (
                    <SelectItem key={model} value={model}>{model}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                name="recommendationsModel"
                placeholder="Optional: model name override"
                value={formState.recommendationsModel}
                onChange={(e) => setFormState({ ...formState, recommendationsModel: e.target.value })}
              />
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="imageAnalysisProvider">Image Analysis Provider</Label>
            <Select
              name="imageAnalysisProvider"
              value={formState.imageAnalysisProvider}
              onValueChange={(value) => setFormState({ ...formState, imageAnalysisProvider: value })}
            >
              <SelectTrigger id="imageAnalysisProvider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude (Anthropic)</SelectItem>
                <SelectItem value="gemini">Gemini (Google)</SelectItem>
                <SelectItem value="ollama">Ollama (Local)</SelectItem>
              </SelectContent>
            </Select>
            {formState.imageAnalysisProvider === "ollama" && ollamaModels.length > 0 ? (
              <Select
                name="imageAnalysisModel"
                value={formState.imageAnalysisModel}
                onValueChange={(value) => setFormState({ ...formState, imageAnalysisModel: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {ollamaModels.map((model) => (
                    <SelectItem key={model} value={model}>{model}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                name="imageAnalysisModel"
                placeholder="Optional: model name override"
                value={formState.imageAnalysisModel}
                onChange={(e) => setFormState({ ...formState, imageAnalysisModel: e.target.value })}
              />
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" disabled={isPending}>
          {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Save Settings
        </Button>
      </div>
    </form>
  );
}
