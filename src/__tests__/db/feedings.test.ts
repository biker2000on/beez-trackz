import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import { feedings, feedTypeEnum, feederTypeEnum, quantityUnitEnum } from "@/db/schema";

describe("feedings schema", () => {
  it("should export feedings table", () => {
    expect(feedings).toBeDefined();
    expect(getTableName(feedings)).toBe("feedings");
  });

  it("should export feedTypeEnum", () => {
    expect(feedTypeEnum).toBeDefined();
    expect(feedTypeEnum.enumValues).toEqual(["sugar_syrup_1to1", "sugar_syrup_2to1", "dry_sugar", "pollen_patty", "fondant", "other"]);
  });

  it("should export feederTypeEnum", () => {
    expect(feederTypeEnum).toBeDefined();
    expect(feederTypeEnum.enumValues).toEqual(["entrance", "top", "frame", "baggie", "bucket", "open", "other"]);
  });

  it("should export quantityUnitEnum", () => {
    expect(quantityUnitEnum).toBeDefined();
    expect(quantityUnitEnum.enumValues).toEqual(["lbs", "oz", "quarts", "gallons"]);
  });
});
