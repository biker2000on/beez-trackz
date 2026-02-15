import type { AIProvider } from "./types";

interface OllamaChatResponse {
  message?: { content?: string };
}

export class OllamaProvider implements AIProvider {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl?: string, model?: string) {
    this.baseUrl = baseUrl || "http://localhost:11434";
    this.model = model || "llama3.2";
  }

  async chat(prompt: string, context?: string): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [];

    if (context) {
      messages.push({ role: "system", content: context });
    }

    messages.push({ role: "user", content: prompt });

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama API error: ${response.status} ${response.statusText}`
      );
    }

    let data: OllamaChatResponse;
    try {
      data = (await response.json()) as OllamaChatResponse;
    } catch {
      throw new Error("Failed to parse Ollama response as JSON");
    }

    const text = data.message?.content;
    if (!text) {
      throw new Error("No text response from Ollama");
    }

    return text;
  }

  async transcribe(_audioBuffer: Buffer): Promise<string> {
    throw new Error(
      "Audio transcription is not supported by Ollama. Use Gemini or a dedicated transcription service."
    );
  }

  async analyzeImage(imageBuffer: Buffer, prompt: string): Promise<string> {
    const base64Image = imageBuffer.toString("base64");

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: "user",
            content: prompt,
            images: [base64Image],
          },
        ],
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama API error: ${response.status} ${response.statusText}`
      );
    }

    let data: OllamaChatResponse;
    try {
      data = (await response.json()) as OllamaChatResponse;
    } catch {
      throw new Error("Failed to parse Ollama image analysis response as JSON");
    }

    const text = data.message?.content;
    if (!text) {
      throw new Error("No text response from Ollama image analysis");
    }

    return text;
  }

  static async listModels(baseUrl: string = "http://localhost:11434"): Promise<string[]> {
    try {
      const response = await fetch(`${baseUrl}/api/tags`);
      if (!response.ok) return [];
      const data = await response.json() as { models?: Array<{ name: string }> };
      return (data.models || []).map((m) => m.name);
    } catch {
      return [];
    }
  }
}
