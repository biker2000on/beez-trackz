import { getAIProvider } from "@/lib/ai";

export interface ParsedImportData {
  apiaries: Array<{ name: string; notes?: string }>;
  hives: Array<{
    apiaryName: string;
    positionLabel: string;
    status?: string;
    notes?: string;
  }>;
  inspections: Array<{
    hiveReference: string;
    date: string;
    queenSeen?: boolean;
    notes?: string;
    broodPattern?: string;
    pests?: Array<{ type: string }>;
    treatments?: Array<{ product: string }>;
  }>;
  equipment: Array<{
    hiveReference: string;
    type: string;
    frameCapacity?: number;
  }>;
}

const PARSE_PROMPT = `You are parsing beekeeping records from various file formats. Extract structured data and return ONLY valid JSON.

Return format:
{
  "apiaries": [{"name": "string", "notes": "string (optional)"}],
  "hives": [{"apiaryName": "string", "positionLabel": "string", "status": "active|dead|sold|combined (optional)", "notes": "string (optional)"}],
  "inspections": [{
    "hiveReference": "string (apiary name + hive position)",
    "date": "ISO 8601 date string",
    "queenSeen": boolean (optional),
    "notes": "string (optional)",
    "broodPattern": "string (optional)",
    "pests": [{"type": "string"}] (optional),
    "treatments": [{"product": "string"}] (optional)
  }],
  "equipment": [{
    "hiveReference": "string (apiary name + hive position)",
    "type": "deep|medium|shallow|queen_excluder|double_screen|inner_cover|outer_cover|bottom_board|entrance_reducer|feeder|other",
    "frameCapacity": number (optional)
  }]
}

Rules:
- Extract ALL apiaries, hives, inspections, and equipment mentioned
- For hiveReference, use format "ApiaryName - HivePosition" (e.g., "Backyard - Hive 1")
- Convert dates to ISO 8601 format (YYYY-MM-DD or full timestamp)
- If status not specified, omit it (defaults to "active")
- For equipment type, map common terms (e.g., "super" → "medium", "box" → "deep")
- Return empty arrays if no data of that type found
- Return ONLY the JSON object, no explanation text`;

export async function parseImportFile(
  content: string,
  fileType: string
): Promise<ParsedImportData> {
  try {
    // For structured formats, try direct parsing first
    if (fileType === "application/json") {
      const parsed = JSON.parse(content);
      return validateParsedData(parsed);
    }

    // Use AI to extract structured data from any format
    const provider = await getAIProvider("import");
    const response = await provider.chat(PARSE_PROMPT, content);

    // Extract JSON from response (handle cases where AI adds explanation)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("AI response did not contain valid JSON");
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return validateParsedData(parsed);
  } catch (error) {
    throw new Error(
      `Failed to parse import file: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

function validateParsedData(data: unknown): ParsedImportData {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid parsed data: must be an object");
  }

  const parsed = data as Record<string, unknown>;

  const apiaries = Array.isArray(parsed.apiaries) ? parsed.apiaries : [];
  const hives = Array.isArray(parsed.hives) ? parsed.hives : [];
  const inspections = Array.isArray(parsed.inspections)
    ? parsed.inspections
    : [];
  const equipment = Array.isArray(parsed.equipment) ? parsed.equipment : [];

  return {
    apiaries: apiaries.map((a) => ({
      name: String((a as Record<string, unknown>).name || "Unnamed Apiary"),
      notes: (a as Record<string, unknown>).notes
        ? String((a as Record<string, unknown>).notes)
        : undefined,
    })),
    hives: hives.map((h) => {
      const hive = h as Record<string, unknown>;
      return {
        apiaryName: String(hive.apiaryName || "Unknown"),
        positionLabel: String(hive.positionLabel || "Unknown"),
        status: hive.status ? String(hive.status) : undefined,
        notes: hive.notes ? String(hive.notes) : undefined,
      };
    }),
    inspections: inspections.map((i) => {
      const inspection = i as Record<string, unknown>;
      return {
        hiveReference: String(inspection.hiveReference || "Unknown"),
        date: String(inspection.date || new Date().toISOString()),
        queenSeen:
          inspection.queenSeen !== undefined
            ? Boolean(inspection.queenSeen)
            : undefined,
        notes: inspection.notes ? String(inspection.notes) : undefined,
        broodPattern: inspection.broodPattern
          ? String(inspection.broodPattern)
          : undefined,
        pests: Array.isArray(inspection.pests)
          ? inspection.pests.map((p) => ({
              type: String((p as Record<string, unknown>).type || "unknown"),
            }))
          : undefined,
        treatments: Array.isArray(inspection.treatments)
          ? inspection.treatments.map((t) => ({
              product: String(
                (t as Record<string, unknown>).product || "unknown"
              ),
            }))
          : undefined,
      };
    }),
    equipment: equipment.map((e) => {
      const equip = e as Record<string, unknown>;
      return {
        hiveReference: String(equip.hiveReference || "Unknown"),
        type: String(equip.type || "other"),
        frameCapacity: equip.frameCapacity
          ? Number(equip.frameCapacity)
          : undefined,
      };
    }),
  };
}
