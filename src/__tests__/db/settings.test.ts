import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import { userSettings } from "@/db/schema";

describe("userSettings schema", () => {
  it("should export userSettings table", () => {
    expect(userSettings).toBeDefined();
    expect(getTableName(userSettings)).toBe("user_settings");
  });
});
