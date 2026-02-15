import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database module before imports
vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

// Mock next/cache (server actions import it)
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Mock next/navigation
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

describe("AI provider types", () => {
  it("should export AIProviderConfig type shape", async () => {
    const mod = await import("@/lib/ai/types");
    // Types exist at compile time; verify the module loads
    expect(mod).toBeDefined();
  });
});

describe("AI provider factory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should export getAIProvider function", async () => {
    const mod = await import("@/lib/ai/index");
    expect(mod.getAIProvider).toBeDefined();
    expect(typeof mod.getAIProvider).toBe("function");
  });

  it("should export parseConfig function", async () => {
    const mod = await import("@/lib/ai/index");
    expect(mod.parseConfig).toBeDefined();
    expect(typeof mod.parseConfig).toBe("function");
  });

  it("should export createProvider function", async () => {
    const mod = await import("@/lib/ai/index");
    expect(mod.createProvider).toBeDefined();
    expect(typeof mod.createProvider).toBe("function");
  });

  it("should return default config for null input", async () => {
    const { parseConfig } = await import("@/lib/ai/index");
    const config = parseConfig(null);

    expect(config.transcription.provider).toBe("gemini");
    expect(config.recommendations.provider).toBe("claude");
    expect(config.imageAnalysis.provider).toBe("claude");
  });

  it("should return default config for non-object input", async () => {
    const { parseConfig } = await import("@/lib/ai/index");
    const config = parseConfig("invalid");

    expect(config.transcription.provider).toBe("gemini");
    expect(config.recommendations.provider).toBe("claude");
    expect(config.imageAnalysis.provider).toBe("claude");
  });

  it("should parse valid config from DB", async () => {
    const { parseConfig } = await import("@/lib/ai/index");
    const config = parseConfig({
      transcription: { provider: "ollama", model: "whisper" },
      recommendations: { provider: "gemini", model: "gemini-2.0-flash" },
      imageAnalysis: { provider: "claude" },
      apiKeys: {
        anthropic: "sk-test-123",
        google: "ai-test-456",
      },
    });

    expect(config.transcription.provider).toBe("ollama");
    expect(config.transcription.model).toBe("whisper");
    expect(config.recommendations.provider).toBe("gemini");
    expect(config.imageAnalysis.provider).toBe("claude");
    expect(config.apiKeys.anthropic).toBe("sk-test-123");
    expect(config.apiKeys.google).toBe("ai-test-456");
  });

  it("should create Claude provider", async () => {
    const { createProvider } = await import("@/lib/ai/index");
    const config = {
      transcription: { provider: "claude" },
      recommendations: { provider: "claude" },
      imageAnalysis: { provider: "claude" },
      apiKeys: { anthropic: "sk-test" },
    };

    const provider = createProvider("claude", config);
    expect(provider).toBeDefined();
    expect(provider.chat).toBeDefined();
    expect(provider.transcribe).toBeDefined();
    expect(provider.analyzeImage).toBeDefined();
  });

  it("should create Gemini provider", async () => {
    const { createProvider } = await import("@/lib/ai/index");
    const config = {
      transcription: { provider: "gemini" },
      recommendations: { provider: "gemini" },
      imageAnalysis: { provider: "gemini" },
      apiKeys: { google: "ai-test" },
    };

    const provider = createProvider("gemini", config);
    expect(provider).toBeDefined();
    expect(provider.chat).toBeDefined();
    expect(provider.transcribe).toBeDefined();
    expect(provider.analyzeImage).toBeDefined();
  });

  it("should create Ollama provider", async () => {
    const { createProvider } = await import("@/lib/ai/index");
    const config = {
      transcription: { provider: "ollama" },
      recommendations: { provider: "ollama" },
      imageAnalysis: { provider: "ollama" },
      apiKeys: { ollamaUrl: "http://localhost:11434" },
    };

    const provider = createProvider("ollama", config);
    expect(provider).toBeDefined();
    expect(provider.chat).toBeDefined();
    expect(provider.transcribe).toBeDefined();
    expect(provider.analyzeImage).toBeDefined();
  });

  it("should throw for unknown provider", async () => {
    const { createProvider } = await import("@/lib/ai/index");
    const config = {
      transcription: { provider: "unknown" },
      recommendations: { provider: "unknown" },
      imageAnalysis: { provider: "unknown" },
      apiKeys: {},
    };

    expect(() => createProvider("unknown", config)).toThrow(
      "Unknown AI provider: unknown"
    );
  });

  it("should throw when Claude API key is missing", async () => {
    const { createProvider } = await import("@/lib/ai/index");
    // Clear env var
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const config = {
      transcription: { provider: "claude" },
      recommendations: { provider: "claude" },
      imageAnalysis: { provider: "claude" },
      apiKeys: {},
    };

    expect(() => createProvider("claude", config)).toThrow(
      "Anthropic API key not configured"
    );

    // Restore
    if (original) process.env.ANTHROPIC_API_KEY = original;
  });

  it("should throw when Gemini API key is missing", async () => {
    const { createProvider } = await import("@/lib/ai/index");
    const original = process.env.GOOGLE_AI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;

    const config = {
      transcription: { provider: "gemini" },
      recommendations: { provider: "gemini" },
      imageAnalysis: { provider: "gemini" },
      apiKeys: {},
    };

    expect(() => createProvider("gemini", config)).toThrow(
      "Google AI API key not configured"
    );

    if (original) process.env.GOOGLE_AI_API_KEY = original;
  });
});

describe("Claude provider", () => {
  it("should export ClaudeProvider class", async () => {
    const mod = await import("@/lib/ai/claude");
    expect(mod.ClaudeProvider).toBeDefined();
  });

  it("should throw on transcribe", async () => {
    const { ClaudeProvider } = await import("@/lib/ai/claude");
    const provider = new ClaudeProvider("sk-test");
    await expect(provider.transcribe(Buffer.from("test"))).rejects.toThrow(
      "not supported"
    );
  });
});

describe("Gemini provider", () => {
  it("should export GeminiProvider class", async () => {
    const mod = await import("@/lib/ai/gemini");
    expect(mod.GeminiProvider).toBeDefined();
  });
});

describe("Ollama provider", () => {
  it("should export OllamaProvider class", async () => {
    const mod = await import("@/lib/ai/ollama");
    expect(mod.OllamaProvider).toBeDefined();
  });

  it("should throw on transcribe", async () => {
    const { OllamaProvider } = await import("@/lib/ai/ollama");
    const provider = new OllamaProvider();
    await expect(provider.transcribe(Buffer.from("test"))).rejects.toThrow(
      "not supported"
    );
  });
});

describe("AI settings actions", () => {
  it("should export getAISettings", async () => {
    const mod = await import("@/actions/ai-settings");
    expect(mod.getAISettings).toBeDefined();
    expect(typeof mod.getAISettings).toBe("function");
  });

  it("should export updateAISettings", async () => {
    const mod = await import("@/actions/ai-settings");
    expect(mod.updateAISettings).toBeDefined();
    expect(typeof mod.updateAISettings).toBe("function");
  });

  it("should export testAIConnection", async () => {
    const mod = await import("@/actions/ai-settings");
    expect(mod.testAIConnection).toBeDefined();
    expect(typeof mod.testAIConnection).toBe("function");
  });
});
