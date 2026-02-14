import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import { aiRecommendations, recommendationTypeEnum } from "@/db/schema";

describe("aiRecommendations schema", () => {
  it("should export aiRecommendations table", () => {
    expect(aiRecommendations).toBeDefined();
    expect(getTableName(aiRecommendations)).toBe("ai_recommendations");
  });

  it("should export recommendationTypeEnum", () => {
    expect(recommendationTypeEnum).toBeDefined();
    expect(recommendationTypeEnum.enumValues).toEqual(["inspection_due", "treatment_reminder", "equipment_needed", "seasonal_prep", "feeder_check"]);
  });
});
