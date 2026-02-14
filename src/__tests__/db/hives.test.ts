import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import { hives, hiveStatusEnum, hiveLocationHistory } from "@/db/schema";

describe("hives schema", () => {
  it("should export hives table", () => {
    expect(hives).toBeDefined();
    expect(getTableName(hives)).toBe("hives");
  });

  it("should export hiveStatusEnum", () => {
    expect(hiveStatusEnum).toBeDefined();
    expect(hiveStatusEnum.enumValues).toEqual(["active", "dead", "sold", "combined"]);
  });
});

describe("hiveLocationHistory schema", () => {
  it("should export hiveLocationHistory table", () => {
    expect(hiveLocationHistory).toBeDefined();
    expect(getTableName(hiveLocationHistory)).toBe("hive_location_history");
  });
});
