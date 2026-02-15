import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database module
vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

// Mock next/cache
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Mock next/navigation
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

// Mock the AI provider
const mockChat = vi.fn();
vi.mock("@/lib/ai", () => ({
  getAIProvider: vi.fn().mockResolvedValue({
    chat: mockChat,
    transcribe: vi.fn(),
    analyzeImage: vi.fn(),
  }),
}));

describe("transcription-parser types", () => {
  it("should export ParsedInspection interface shape", async () => {
    const mod = await import("@/lib/ai/transcription-parser");
    expect(mod).toBeDefined();

    // Verify module has expected exports
    expect(mod.parseTranscription).toBeDefined();
    expect(typeof mod.parseTranscription).toBe("function");
    expect(mod.buildPrompt).toBeDefined();
    expect(typeof mod.buildPrompt).toBe("function");
  });

  it("ParsedInspection should allow all optional fields", () => {
    // Type-level test: a minimal ParsedInspection is an empty object
    const minimal: import("@/lib/ai/transcription-parser").ParsedInspection = {};
    expect(minimal).toBeDefined();
  });

  it("ParsedInspection should accept full fields", () => {
    const full: import("@/lib/ai/transcription-parser").ParsedInspection = {
      hiveReference: "hive 1",
      queenSeen: true,
      queenHealth: "healthy, laying well",
      broodPattern: "solid brood pattern",
      storesHoney: 4,
      storesPollen: 3,
      temperament: 2,
      pests: [{ type: "varroa mites", count: "moderate" }],
      treatments: [{ product: "oxalic acid", method: "dribble" }],
      notes: "Good overall condition",
    };

    expect(full.hiveReference).toBe("hive 1");
    expect(full.queenSeen).toBe(true);
    expect(full.storesHoney).toBe(4);
    expect(full.pests).toHaveLength(1);
    expect(full.treatments).toHaveLength(1);
  });

  it("TranscriptionResult should have rawText and inspections array", () => {
    const result: import("@/lib/ai/transcription-parser").TranscriptionResult = {
      rawText: "Some transcription text",
      inspections: [],
    };

    expect(result.rawText).toBe("Some transcription text");
    expect(result.inspections).toEqual([]);
  });
});

describe("buildPrompt", () => {
  it("returns a single-mode prompt for single mode", async () => {
    const { buildPrompt } = await import("@/lib/ai/transcription-parser");
    const prompt = buildPrompt("single");

    expect(prompt).toContain("queenSeen");
    expect(prompt).toContain("storesHoney");
    expect(prompt).toContain("temperament");
    expect(prompt).toContain("pests");
    expect(prompt).toContain("treatments");
    expect(prompt).not.toContain("hiveReference");
    expect(prompt).not.toContain("MULTIPLE hives");
  });

  it("returns a batch-mode prompt for batch mode", async () => {
    const { buildPrompt } = await import("@/lib/ai/transcription-parser");
    const prompt = buildPrompt("batch");

    expect(prompt).toContain("hiveReference");
    expect(prompt).toContain("MULTIPLE hives");
    expect(prompt).toContain("queenSeen");
    expect(prompt).toContain("storesHoney");
    expect(prompt).toContain("Segment the transcription by hive");
  });

  it("both prompts request JSON-only output", async () => {
    const { buildPrompt } = await import("@/lib/ai/transcription-parser");

    const single = buildPrompt("single");
    const batch = buildPrompt("batch");

    expect(single).toContain("Return ONLY valid JSON");
    expect(batch).toContain("Return ONLY valid JSON");
  });
});

describe("parseTranscription - single mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses a complete single inspection response", async () => {
    const { parseTranscription } = await import("@/lib/ai/transcription-parser");

    const aiResponse = JSON.stringify({
      queenSeen: true,
      queenHealth: "healthy, good laying pattern",
      broodPattern: "solid across 6 frames",
      storesHoney: 4,
      storesPollen: 3,
      temperament: 2,
      pests: [{ type: "varroa mites", count: "low" }],
      treatments: [{ product: "Apivar", method: "strips between frames" }],
      notes: "Strong colony, ready for super",
    });

    mockChat.mockResolvedValueOnce(aiResponse);

    const result = await parseTranscription(
      "I checked hive one today and saw the queen...",
      "single"
    );

    expect(result.rawText).toBe("I checked hive one today and saw the queen...");
    expect(result.inspections).toHaveLength(1);

    const inspection = result.inspections[0];
    expect(inspection.queenSeen).toBe(true);
    expect(inspection.queenHealth).toBe("healthy, good laying pattern");
    expect(inspection.broodPattern).toBe("solid across 6 frames");
    expect(inspection.storesHoney).toBe(4);
    expect(inspection.storesPollen).toBe(3);
    expect(inspection.temperament).toBe(2);
    expect(inspection.pests).toHaveLength(1);
    expect(inspection.pests![0].type).toBe("varroa mites");
    expect(inspection.treatments).toHaveLength(1);
    expect(inspection.treatments![0].product).toBe("Apivar");
    expect(inspection.notes).toBe("Strong colony, ready for super");
  });

  it("handles AI returning JSON wrapped in markdown code fences", async () => {
    const { parseTranscription } = await import("@/lib/ai/transcription-parser");

    const aiResponse = '```json\n{"queenSeen": false, "notes": "Queenless colony"}\n```';
    mockChat.mockResolvedValueOnce(aiResponse);

    const result = await parseTranscription("Could not find the queen", "single");

    expect(result.inspections).toHaveLength(1);
    expect(result.inspections[0].queenSeen).toBe(false);
    expect(result.inspections[0].notes).toBe("Queenless colony");
  });

  it("handles AI returning invalid JSON gracefully", async () => {
    const { parseTranscription } = await import("@/lib/ai/transcription-parser");

    mockChat.mockResolvedValueOnce("This is not valid JSON at all");

    const result = await parseTranscription("Some transcription text", "single");

    expect(result.rawText).toBe("Some transcription text");
    expect(result.inspections).toEqual([]);
  });

  it("validates numeric ranges - clamps to valid range", async () => {
    const { parseTranscription } = await import("@/lib/ai/transcription-parser");

    const aiResponse = JSON.stringify({
      storesHoney: 7, // Out of range
      storesPollen: 0, // Out of range
      temperament: 3,
    });

    mockChat.mockResolvedValueOnce(aiResponse);

    const result = await parseTranscription("Some text", "single");

    expect(result.inspections).toHaveLength(1);
    // Out-of-range values are omitted
    expect(result.inspections[0].storesHoney).toBeUndefined();
    expect(result.inspections[0].storesPollen).toBeUndefined();
    expect(result.inspections[0].temperament).toBe(3);
  });

  it("handles partial data - only mentioned fields", async () => {
    const { parseTranscription } = await import("@/lib/ai/transcription-parser");

    const aiResponse = JSON.stringify({
      queenSeen: true,
      notes: "Quick check, queen spotted",
    });

    mockChat.mockResolvedValueOnce(aiResponse);

    const result = await parseTranscription("Quick look, saw the queen", "single");

    expect(result.inspections).toHaveLength(1);
    const inspection = result.inspections[0];
    expect(inspection.queenSeen).toBe(true);
    expect(inspection.notes).toBe("Quick check, queen spotted");
    expect(inspection.broodPattern).toBeUndefined();
    expect(inspection.storesHoney).toBeUndefined();
    expect(inspection.pests).toBeUndefined();
  });
});

describe("parseTranscription - batch mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses multiple hive inspections", async () => {
    const { parseTranscription } = await import("@/lib/ai/transcription-parser");

    const aiResponse = JSON.stringify([
      {
        hiveReference: "hive 1",
        queenSeen: true,
        queenHealth: "good",
        storesHoney: 4,
        temperament: 1,
      },
      {
        hiveReference: "the blue hive",
        queenSeen: false,
        notes: "Couldn't find queen, may need to requeen",
        pests: [{ type: "hive beetles", count: "3 spotted" }],
      },
      {
        hiveReference: "number three",
        queenSeen: true,
        broodPattern: "spotty",
        storesHoney: 2,
        storesPollen: 2,
        treatments: [{ product: "oxalic acid", method: "vaporization" }],
      },
    ]);

    mockChat.mockResolvedValueOnce(aiResponse);

    const result = await parseTranscription(
      "Starting with hive 1, the queen looks good...",
      "batch"
    );

    expect(result.inspections).toHaveLength(3);

    expect(result.inspections[0].hiveReference).toBe("hive 1");
    expect(result.inspections[0].queenSeen).toBe(true);
    expect(result.inspections[0].storesHoney).toBe(4);

    expect(result.inspections[1].hiveReference).toBe("the blue hive");
    expect(result.inspections[1].queenSeen).toBe(false);
    expect(result.inspections[1].pests).toHaveLength(1);

    expect(result.inspections[2].hiveReference).toBe("number three");
    expect(result.inspections[2].broodPattern).toBe("spotty");
    expect(result.inspections[2].treatments).toHaveLength(1);
    expect(result.inspections[2].treatments![0].product).toBe("oxalic acid");
  });

  it("handles AI returning a single object in batch mode", async () => {
    const { parseTranscription } = await import("@/lib/ai/transcription-parser");

    const aiResponse = JSON.stringify({
      hiveReference: "the only hive",
      queenSeen: true,
      notes: "Single hive mentioned",
    });

    mockChat.mockResolvedValueOnce(aiResponse);

    const result = await parseTranscription(
      "Just checked the only hive...",
      "batch"
    );

    expect(result.inspections).toHaveLength(1);
    expect(result.inspections[0].hiveReference).toBe("the only hive");
  });

  it("filters invalid pest and treatment entries", async () => {
    const { parseTranscription } = await import("@/lib/ai/transcription-parser");

    const aiResponse = JSON.stringify([
      {
        hiveReference: "hive A",
        pests: [
          { type: "varroa", count: "high" },
          { notType: "invalid entry" }, // Missing 'type' field
          "just a string", // Not an object
        ],
        treatments: [
          { product: "thymol", method: "strips" },
          { noProduct: "invalid" }, // Missing 'product' field
        ],
      },
    ]);

    mockChat.mockResolvedValueOnce(aiResponse);

    const result = await parseTranscription("Hive A has varroa...", "batch");

    expect(result.inspections).toHaveLength(1);
    expect(result.inspections[0].pests).toHaveLength(1);
    expect(result.inspections[0].pests![0].type).toBe("varroa");
    expect(result.inspections[0].treatments).toHaveLength(1);
    expect(result.inspections[0].treatments![0].product).toBe("thymol");
  });
});

describe("parseTranscription - edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles empty transcription text", async () => {
    const { parseTranscription } = await import("@/lib/ai/transcription-parser");

    const aiResponse = JSON.stringify({});
    mockChat.mockResolvedValueOnce(aiResponse);

    const result = await parseTranscription("", "single");

    expect(result.rawText).toBe("");
    expect(result.inspections).toHaveLength(1);
    // Empty object means all fields are undefined
    const inspection = result.inspections[0];
    expect(inspection.queenSeen).toBeUndefined();
    expect(inspection.notes).toBeUndefined();
  });

  it("passes transcription text as context to AI chat", async () => {
    const { parseTranscription } = await import("@/lib/ai/transcription-parser");

    mockChat.mockResolvedValueOnce(JSON.stringify({ queenSeen: true }));

    await parseTranscription("My transcription text here", "single");

    expect(mockChat).toHaveBeenCalledTimes(1);
    const [prompt, context] = mockChat.mock.calls[0];
    expect(typeof prompt).toBe("string");
    expect(context).toBe("My transcription text here");
  });

  it("AI returning an array in single mode uses first element", async () => {
    const { parseTranscription } = await import("@/lib/ai/transcription-parser");

    const aiResponse = JSON.stringify([
      { queenSeen: true, notes: "First" },
      { queenSeen: false, notes: "Second" },
    ]);

    mockChat.mockResolvedValueOnce(aiResponse);

    const result = await parseTranscription("Some text", "single");

    expect(result.inspections).toHaveLength(1);
    expect(result.inspections[0].queenSeen).toBe(true);
    expect(result.inspections[0].notes).toBe("First");
  });

  it("rounds fractional numeric values", async () => {
    const { parseTranscription } = await import("@/lib/ai/transcription-parser");

    const aiResponse = JSON.stringify({
      storesHoney: 3.7,
      storesPollen: 2.2,
      temperament: 1.5,
    });

    mockChat.mockResolvedValueOnce(aiResponse);

    const result = await parseTranscription("Some text", "single");

    expect(result.inspections[0].storesHoney).toBe(4);
    expect(result.inspections[0].storesPollen).toBe(2);
    expect(result.inspections[0].temperament).toBe(2);
  });
});
