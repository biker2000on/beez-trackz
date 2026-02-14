import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import { inspections } from "@/db/schema";

describe("inspections schema", () => {
  it("should export inspections table", () => {
    expect(inspections).toBeDefined();
    expect(getTableName(inspections)).toBe("inspections");
  });
});
