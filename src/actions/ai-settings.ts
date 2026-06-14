"use server";

import { requireSession } from "@/lib/require-session";
import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { AIProviderConfig } from "@/lib/ai/types";
import { normalizeFormData } from "@/lib/form-values";

export async function getAISettings(): Promise<AIProviderConfig | null> {
  await requireSession();
  const users = await db.select().from(userSettings).limit(1);

  if (users.length === 0) {
    return null;
  }

  const raw = users[0].aiProviderConfig;
  if (!raw || typeof raw !== "object") {
    return null;
  }

  try {
    return raw as AIProviderConfig;
  } catch {
    return null;
  }
}

export async function updateAISettings(
  _prevState: unknown,
  formData: FormData
) {
  await requireSession();
  formData = normalizeFormData(formData);
  const users = await db.select().from(userSettings).limit(1);

  if (users.length === 0) {
    return { error: "No user account found. Complete setup first." };
  }

  const transcriptionProvider = formData.get("transcriptionProvider") as string;
  const transcriptionModel = formData.get("transcriptionModel") as string;
  const recommendationsProvider = formData.get("recommendationsProvider") as string;
  const recommendationsModel = formData.get("recommendationsModel") as string;
  const imageAnalysisProvider = formData.get("imageAnalysisProvider") as string;
  const imageAnalysisModel = formData.get("imageAnalysisModel") as string;
  const anthropicKey = formData.get("anthropicKey") as string;
  const googleKey = formData.get("googleKey") as string;
  const ollamaUrl = formData.get("ollamaUrl") as string;

  const validProviders = ["claude", "gemini", "ollama"];

  if (transcriptionProvider && !validProviders.includes(transcriptionProvider)) {
    return { error: "Invalid transcription provider" };
  }

  if (recommendationsProvider && !validProviders.includes(recommendationsProvider)) {
    return { error: "Invalid recommendations provider" };
  }

  if (imageAnalysisProvider && !validProviders.includes(imageAnalysisProvider)) {
    return { error: "Invalid image analysis provider" };
  }

  const config: AIProviderConfig = {
    transcription: {
      provider: transcriptionProvider || "gemini",
      model: transcriptionModel || undefined,
    },
    recommendations: {
      provider: recommendationsProvider || "claude",
      model: recommendationsModel || undefined,
    },
    imageAnalysis: {
      provider: imageAnalysisProvider || "claude",
      model: imageAnalysisModel || undefined,
    },
    apiKeys: {
      anthropic: anthropicKey || undefined,
      google: googleKey || undefined,
      ollamaUrl: ollamaUrl || undefined,
    },
  };

  await db
    .update(userSettings)
    .set({
      aiProviderConfig: config,
      updatedAt: new Date(),
    })
    .where(eq(userSettings.id, users[0].id));

  revalidatePath("/settings");
  return { success: true };
}

export async function testAIConnection(provider: string, apiKey: string) {
  await requireSession();
  if (!provider) {
    return { error: "Provider is required" };
  }

  try {
    switch (provider) {
      case "claude": {
        if (!apiKey) {
          return { error: "API key is required for Claude" };
        }
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        const client = new Anthropic({ apiKey });
        await client.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 10,
          messages: [{ role: "user", content: "Hi" }],
        });
        return { success: true, message: "Claude connection successful" };
      }
      case "gemini": {
        if (!apiKey) {
          return { error: "API key is required for Gemini" };
        }
        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        await model.generateContent("Hi");
        return { success: true, message: "Gemini connection successful" };
      }
      case "ollama": {
        const baseUrl = apiKey || "http://localhost:11434";
        const response = await fetch(`${baseUrl}/api/tags`);
        if (!response.ok) {
          return { error: `Ollama not reachable at ${baseUrl}` };
        }
        return { success: true, message: "Ollama connection successful" };
      }
      default:
        return { error: `Unknown provider: ${provider}` };
    }
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown error occurred";
    return { error: `Connection failed: ${message}` };
  }
}

export async function getOllamaModels(baseUrl?: string) {
  await requireSession();
  const { OllamaProvider } = await import("@/lib/ai/ollama");
  return OllamaProvider.listModels(baseUrl || "http://localhost:11434");
}
