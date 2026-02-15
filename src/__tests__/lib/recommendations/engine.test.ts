import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing modules under test
// ---------------------------------------------------------------------------

// Mock the database module
vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
          limit: vi.fn().mockResolvedValue([]),
        }),
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
          orderBy: vi.fn().mockResolvedValue([]),
        }),
        limit: vi.fn().mockResolvedValue([]),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue([]),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
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

// Mock AI provider
vi.mock("@/lib/ai", () => ({
  getAIProvider: vi.fn().mockResolvedValue({
    chat: vi.fn().mockResolvedValue("Enriched message"),
    transcribe: vi.fn(),
    analyzeImage: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Tests: Rule definitions
// ---------------------------------------------------------------------------

describe("recommendation rules", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should export recommendationRules array", async () => {
    const mod = await import("@/lib/recommendations/rules");
    expect(mod.recommendationRules).toBeDefined();
    expect(Array.isArray(mod.recommendationRules)).toBe(true);
  });

  it("should have a rule for each recommendation type", async () => {
    const { recommendationRules } = await import(
      "@/lib/recommendations/rules"
    );

    const expectedTypes = [
      "inspection_due",
      "treatment_reminder",
      "equipment_needed",
      "feeder_check",
      "seasonal_prep",
    ];

    const ruleTypes = recommendationRules.map((r) => r.type);
    for (const type of expectedTypes) {
      expect(ruleTypes).toContain(type);
    }
  });

  it("should have exactly 5 rules", async () => {
    const { recommendationRules } = await import(
      "@/lib/recommendations/rules"
    );
    expect(recommendationRules).toHaveLength(5);
  });

  it("each rule should have a type and check function", async () => {
    const { recommendationRules } = await import(
      "@/lib/recommendations/rules"
    );

    for (const rule of recommendationRules) {
      expect(typeof rule.type).toBe("string");
      expect(typeof rule.check).toBe("function");
    }
  });

  it("should export daysBetween helper", async () => {
    const { daysBetween } = await import("@/lib/recommendations/rules");
    expect(typeof daysBetween).toBe("function");

    const a = new Date("2025-01-01");
    const b = new Date("2025-01-15");
    expect(daysBetween(a, b)).toBe(14);
  });

  it("should export estimateTreatmentDurationDays helper", async () => {
    const { estimateTreatmentDurationDays } = await import(
      "@/lib/recommendations/rules"
    );
    expect(typeof estimateTreatmentDurationDays).toBe("function");

    // Known treatment types
    expect(estimateTreatmentDurationDays("apivar strips")).toBe(42);
    expect(estimateTreatmentDurationDays("Formic acid")).toBe(14);
    expect(estimateTreatmentDurationDays("apiguard")).toBe(28);
    expect(estimateTreatmentDurationDays("oxalic acid vaporization")).toBe(7);
    expect(estimateTreatmentDurationDays("oxalic dribble")).toBe(1);

    // Unknown defaults to 14
    expect(estimateTreatmentDurationDays("something unknown")).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// Tests: Engine exports
// ---------------------------------------------------------------------------

describe("recommendation engine", () => {
  it("should export runRecommendationCheck function", async () => {
    const mod = await import("@/lib/recommendations/engine");
    expect(mod.runRecommendationCheck).toBeDefined();
    expect(typeof mod.runRecommendationCheck).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Tests: Server actions
// ---------------------------------------------------------------------------

describe("recommendation actions", () => {
  it("should export getActiveRecommendations", async () => {
    const mod = await import("@/actions/recommendations");
    expect(mod.getActiveRecommendations).toBeDefined();
    expect(typeof mod.getActiveRecommendations).toBe("function");
  });

  it("should export dismissRecommendation", async () => {
    const mod = await import("@/actions/recommendations");
    expect(mod.dismissRecommendation).toBeDefined();
    expect(typeof mod.dismissRecommendation).toBe("function");
  });

  it("should export runRecommendationCheck", async () => {
    const mod = await import("@/actions/recommendations");
    expect(mod.runRecommendationCheck).toBeDefined();
    expect(typeof mod.runRecommendationCheck).toBe("function");
  });

  it("should export getRecommendationCount", async () => {
    const mod = await import("@/actions/recommendations");
    expect(mod.getRecommendationCount).toBeDefined();
    expect(typeof mod.getRecommendationCount).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Tests: BullMQ queue exports
// ---------------------------------------------------------------------------

describe("recommendation queue", () => {
  it("should export recommendationQueue", async () => {
    const mod = await import("@/lib/queue/recommendations");
    expect(mod.recommendationQueue).toBeDefined();
  });

  it("should export scheduleRecommendationCheck function", async () => {
    const mod = await import("@/lib/queue/recommendations");
    expect(mod.scheduleRecommendationCheck).toBeDefined();
    expect(typeof mod.scheduleRecommendationCheck).toBe("function");
  });

  it("should export createRecommendationWorker function", async () => {
    const mod = await import("@/lib/queue/recommendations");
    expect(mod.createRecommendationWorker).toBeDefined();
    expect(typeof mod.createRecommendationWorker).toBe("function");
  });
});
