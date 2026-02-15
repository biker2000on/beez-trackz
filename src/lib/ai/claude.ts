import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider } from "./types";

export class ClaudeProvider implements AIProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model || "claude-sonnet-4-20250514";
  }

  async chat(prompt: string, context?: string): Promise<string> {
    const messages: Anthropic.MessageParam[] = [];

    if (context) {
      messages.push({ role: "user", content: context });
      messages.push({ role: "assistant", content: "Understood. I have the context." });
    }

    messages.push({ role: "user", content: prompt });

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      messages,
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Claude");
    }

    return textBlock.text;
  }

  async transcribe(_audioBuffer: Buffer): Promise<string> {
    throw new Error(
      "Audio transcription is not supported by Claude. Use Gemini or a dedicated transcription service."
    );
  }

  async analyzeImage(imageBuffer: Buffer, prompt: string): Promise<string> {
    const base64Image = imageBuffer.toString("base64");

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: base64Image,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Claude image analysis");
    }

    return textBlock.text;
  }
}
