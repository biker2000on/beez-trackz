export interface AIProvider {
  chat(prompt: string, context?: string): Promise<string>;
  transcribe(audioBuffer: Buffer): Promise<string>;
  analyzeImage(imageBuffer: Buffer, prompt: string): Promise<string>;
}

export interface AIProviderConfig {
  transcription: { provider: string; model?: string };
  recommendations: { provider: string; model?: string };
  imageAnalysis: { provider: string; model?: string };
  import?: { provider: string; model?: string };
  apiKeys: {
    anthropic?: string;
    google?: string;
    ollamaUrl?: string;
  };
}

export type AITask = "transcription" | "recommendations" | "imageAnalysis" | "import";
