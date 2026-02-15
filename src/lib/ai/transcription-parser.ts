import { getAIProvider } from "@/lib/ai";

export interface ParsedInspection {
  hiveReference?: string;
  queenSeen?: boolean;
  queenHealth?: string;
  broodPattern?: string;
  storesHoney?: number;
  storesPollen?: number;
  temperament?: number;
  pests?: Array<{ type: string; count?: string }>;
  treatments?: Array<{ product: string; method?: string }>;
  notes?: string;
}

export interface TranscriptionResult {
  rawText: string;
  inspections: ParsedInspection[];
}

const SINGLE_MODE_PROMPT = `You are a beekeeping inspection data extractor. Given a transcription of a beekeeper describing a hive inspection, extract structured fields.

Return ONLY valid JSON with this exact shape (omit fields that aren't mentioned):
{
  "queenSeen": boolean,
  "queenHealth": "string describing queen condition",
  "broodPattern": "string describing brood pattern",
  "storesHoney": number from 1 to 5,
  "storesPollen": number from 1 to 5,
  "temperament": number from 1 to 5 (1=calm, 5=aggressive),
  "pests": [{"type": "pest name", "count": "optional count or severity"}],
  "treatments": [{"product": "treatment name", "method": "optional application method"}],
  "notes": "any additional observations not captured above"
}

Rules:
- For numeric scales (storesHoney, storesPollen, temperament), interpret qualitative descriptions: "low"=1-2, "medium/moderate"=3, "high/good"=4, "excellent/full"=5
- For queenSeen, look for phrases like "saw the queen", "queen spotted", "couldn't find the queen", "queenless"
- For pests, look for: varroa mites, hive beetles, wax moths, ants, etc.
- For treatments, look for: oxalic acid, formic acid, Apivar, thymol, etc.
- Only include fields that are clearly mentioned or implied in the text
- Return ONLY the JSON object, no markdown, no explanation`;

const BATCH_MODE_PROMPT = `You are a beekeeping inspection data extractor. Given a transcription of a beekeeper describing inspections of MULTIPLE hives, identify each hive reference and extract structured fields for each.

Return ONLY valid JSON as an array with this exact shape:
[
  {
    "hiveReference": "the identifier used for this hive (e.g. 'hive 1', 'the blue hive', 'number three')",
    "queenSeen": boolean,
    "queenHealth": "string describing queen condition",
    "broodPattern": "string describing brood pattern",
    "storesHoney": number from 1 to 5,
    "storesPollen": number from 1 to 5,
    "temperament": number from 1 to 5 (1=calm, 5=aggressive),
    "pests": [{"type": "pest name", "count": "optional count or severity"}],
    "treatments": [{"product": "treatment name", "method": "optional application method"}],
    "notes": "any additional observations not captured above"
  }
]

Rules:
- First, identify all distinct hive references in the text (e.g. "hive 1", "the blue hive", "number three", "first hive", "next hive")
- Segment the transcription by hive and extract fields for each
- For numeric scales (storesHoney, storesPollen, temperament), interpret qualitative descriptions: "low"=1-2, "medium/moderate"=3, "high/good"=4, "excellent/full"=5
- For queenSeen, look for phrases like "saw the queen", "queen spotted", "couldn't find the queen", "queenless"
- For pests, look for: varroa mites, hive beetles, wax moths, ants, etc.
- For treatments, look for: oxalic acid, formic acid, Apivar, thymol, etc.
- Only include fields that are clearly mentioned or implied
- If a statement applies to all hives (e.g. "treated all hives with oxalic acid"), include it in each hive's data
- Return ONLY the JSON array, no markdown, no explanation`;

export function buildPrompt(mode: "single" | "batch"): string {
  return mode === "single" ? SINGLE_MODE_PROMPT : BATCH_MODE_PROMPT;
}

function sanitizeJsonResponse(text: string): string {
  let cleaned = text.trim();

  // Strip markdown code fences if present
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  return cleaned.trim();
}

function validateParsedInspection(raw: Record<string, unknown>): ParsedInspection {
  const result: ParsedInspection = {};

  if (typeof raw.hiveReference === "string") {
    result.hiveReference = raw.hiveReference;
  }

  if (typeof raw.queenSeen === "boolean") {
    result.queenSeen = raw.queenSeen;
  }

  if (typeof raw.queenHealth === "string" && raw.queenHealth.trim()) {
    result.queenHealth = raw.queenHealth.trim();
  }

  if (typeof raw.broodPattern === "string" && raw.broodPattern.trim()) {
    result.broodPattern = raw.broodPattern.trim();
  }

  if (typeof raw.storesHoney === "number" && raw.storesHoney >= 1 && raw.storesHoney <= 5) {
    result.storesHoney = Math.round(raw.storesHoney);
  }

  if (typeof raw.storesPollen === "number" && raw.storesPollen >= 1 && raw.storesPollen <= 5) {
    result.storesPollen = Math.round(raw.storesPollen);
  }

  if (typeof raw.temperament === "number" && raw.temperament >= 1 && raw.temperament <= 5) {
    result.temperament = Math.round(raw.temperament);
  }

  if (Array.isArray(raw.pests)) {
    result.pests = raw.pests
      .filter(
        (p: unknown): p is { type: string; count?: string } =>
          typeof p === "object" && p !== null && typeof (p as Record<string, unknown>).type === "string"
      )
      .map((p) => ({
        type: p.type,
        ...(p.count !== undefined ? { count: String(p.count) } : {}),
      }));
  }

  if (Array.isArray(raw.treatments)) {
    result.treatments = raw.treatments
      .filter(
        (t: unknown): t is { product: string; method?: string } =>
          typeof t === "object" && t !== null && typeof (t as Record<string, unknown>).product === "string"
      )
      .map((t) => ({
        product: t.product,
        ...(t.method !== undefined ? { method: String(t.method) } : {}),
      }));
  }

  if (typeof raw.notes === "string" && raw.notes.trim()) {
    result.notes = raw.notes.trim();
  }

  return result;
}

export async function parseTranscription(
  text: string,
  mode: "single" | "batch"
): Promise<TranscriptionResult> {
  const provider = await getAIProvider("transcription");
  const prompt = buildPrompt(mode);
  const response = await provider.chat(prompt, text);

  const cleaned = sanitizeJsonResponse(response);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // If AI returned invalid JSON, return raw text with empty inspections
    return {
      rawText: text,
      inspections: [],
    };
  }

  let inspections: ParsedInspection[];

  if (mode === "single") {
    // Single mode returns a single object
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      inspections = [validateParsedInspection(parsed as Record<string, unknown>)];
    } else if (Array.isArray(parsed) && parsed.length > 0) {
      // AI might return an array even in single mode
      inspections = [validateParsedInspection(parsed[0] as Record<string, unknown>)];
    } else {
      inspections = [];
    }
  } else {
    // Batch mode returns an array
    if (Array.isArray(parsed)) {
      inspections = parsed.map((item) =>
        validateParsedInspection(item as Record<string, unknown>)
      );
    } else if (typeof parsed === "object" && parsed !== null) {
      // AI might return a single object even in batch mode
      inspections = [validateParsedInspection(parsed as Record<string, unknown>)];
    } else {
      inspections = [];
    }
  }

  return {
    rawText: text,
    inspections,
  };
}
