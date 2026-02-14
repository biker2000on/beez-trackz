import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import { apiaries } from "@/db/schema";

describe("apiaries schema", () => {
  it("should export apiaries table", () => {
    expect(apiaries).toBeDefined();
    expect(getTableName(apiaries)).toBe("apiaries");
  });
});
