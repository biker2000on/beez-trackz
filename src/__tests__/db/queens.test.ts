import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import { queens, queenOriginEnum, queenStatusEnum } from "@/db/schema";

describe("queens schema", () => {
  it("should export queens table", () => {
    expect(queens).toBeDefined();
    expect(getTableName(queens)).toBe("queens");
  });

  it("should export queenOriginEnum", () => {
    expect(queenOriginEnum).toBeDefined();
    expect(queenOriginEnum.enumValues).toEqual(["purchased", "swarm", "raised", "walked", "emergency_cell", "unknown"]);
  });

  it("should export queenStatusEnum", () => {
    expect(queenStatusEnum).toBeDefined();
    expect(queenStatusEnum.enumValues).toEqual(["active", "superseded", "dead", "missing"]);
  });
});
