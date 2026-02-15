import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AIProvider } from "./types";

export class GeminiProvider implements AIProvider {
  private genAI: GoogleGenerativeAI;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = model || "gemini-2.0-flash";
  }

  async chat(prompt: string, context?: string): Promise<string> {
    const model = this.genAI.getGenerativeModel({ model: this.model });

    const fullPrompt = context ? `Context:\n${context}\n\n${prompt}` : prompt;

    const result = await model.generateContent(fullPrompt);
    const response = result.response;
    const text = response.text();

    if (!text) {
      throw new Error("No text response from Gemini");
    }

    return text;
  }

  async transcribe(audioBuffer: Buffer): Promise<string> {
    const model = this.genAI.getGenerativeModel({ model: this.model });

    const audioPart = {
      inlineData: {
        mimeType: "audio/webm",
        data: audioBuffer.toString("base64"),
      },
    };

    const result = await model.generateContent([
      "Transcribe the following audio accurately. Return only the transcription text, no additional commentary.",
      audioPart,
    ]);

    const response = result.response;
    const text = response.text();

    if (!text) {
      throw new Error("No transcription response from Gemini");
    }

    return text;
  }

  async analyzeImage(imageBuffer: Buffer, prompt: string): Promise<string> {
    const model = this.genAI.getGenerativeModel({ model: this.model });

    const imagePart = {
      inlineData: {
        mimeType: "image/jpeg",
        data: imageBuffer.toString("base64"),
      },
    };

    const result = await model.generateContent([prompt, imagePart]);
    const response = result.response;
    const text = response.text();

    if (!text) {
      throw new Error("No text response from Gemini image analysis");
    }

    return text;
  }
}
