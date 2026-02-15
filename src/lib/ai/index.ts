import { db } from "@/db";
import { userSettings } from "@/db/schema";
import type { AIProvider, AIProviderConfig, AITask } from "./types";
import { ClaudeProvider } from "./claude";
import { GeminiProvider } from "./gemini";
import { OllamaProvider } from "./ollama";

export type { AIProvider, AIProviderConfig, AITask } from "./types";

function createProvider(
  providerName: string,
  config: AIProviderConfig,
  model?: string
): AIProvider {
  switch (providerName) {
    case "claude": {
      const apiKey =
        config.apiKeys.anthropic || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          "Anthropic API key not configured. Set it in AI settings or ANTHROPIC_API_KEY environment variable."
        );
      }
      return new ClaudeProvider(apiKey, model);
    }
    case "gemini": {
      const apiKey =
        config.apiKeys.google || process.env.GOOGLE_AI_API_KEY;
      if (!apiKey) {
        throw new Error(
          "Google AI API key not configured. Set it in AI settings or GOOGLE_AI_API_KEY environment variable."
        );
      }
      return new GeminiProvider(apiKey, model);
    }
    case "ollama": {
      const baseUrl =
        config.apiKeys.ollamaUrl || process.env.OLLAMA_URL || "http://localhost:11434";
      return new OllamaProvider(baseUrl, model);
    }
    default:
      throw new Error(`Unknown AI provider: ${providerName}`);
  }
}

function getDefaultConfig(): AIProviderConfig {
  return {
    transcription: { provider: "gemini" },
    recommendations: { provider: "claude" },
    imageAnalysis: { provider: "claude" },
    apiKeys: {
      anthropic: process.env.ANTHROPIC_API_KEY,
      google: process.env.GOOGLE_AI_API_KEY,
      ollamaUrl: process.env.OLLAMA_URL,
    },
  };
}

function parseConfig(raw: unknown): AIProviderConfig {
  if (!raw || typeof raw !== "object") {
    return getDefaultConfig();
  }

  try {
    const config = raw as Record<string, unknown>;
    const defaults = getDefaultConfig();

    const transcription =
      config.transcription && typeof config.transcription === "object"
        ? (config.transcription as AIProviderConfig["transcription"])
        : defaults.transcription;

    const recommendations =
      config.recommendations && typeof config.recommendations === "object"
        ? (config.recommendations as AIProviderConfig["recommendations"])
        : defaults.recommendations;

    const imageAnalysis =
      config.imageAnalysis && typeof config.imageAnalysis === "object"
        ? (config.imageAnalysis as AIProviderConfig["imageAnalysis"])
        : defaults.imageAnalysis;

    const rawKeys =
      config.apiKeys && typeof config.apiKeys === "object"
        ? (config.apiKeys as Record<string, string | undefined>)
        : {};

    return {
      transcription,
      recommendations,
      imageAnalysis,
      apiKeys: {
        anthropic: rawKeys.anthropic || defaults.apiKeys.anthropic,
        google: rawKeys.google || defaults.apiKeys.google,
        ollamaUrl: rawKeys.ollamaUrl || defaults.apiKeys.ollamaUrl,
      },
    };
  } catch {
    return getDefaultConfig();
  }
}

export async function getAIProvider(task: AITask): Promise<AIProvider> {
  const users = await db.select().from(userSettings).limit(1);
  const config = parseConfig(users[0]?.aiProviderConfig);

  const taskConfig = config[task];
  return createProvider(taskConfig.provider, config, taskConfig.model);
}

export { parseConfig, createProvider, getDefaultConfig };
