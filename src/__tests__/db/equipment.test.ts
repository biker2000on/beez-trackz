import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import { equipment, equipmentTypeEnum, frameTypeEnum } from "@/db/schema";

describe("equipment schema", () => {
  it("should export equipment table", () => {
    expect(equipment).toBeDefined();
    expect(getTableName(equipment)).toBe("equipment");
  });

  it("should export equipmentTypeEnum", () => {
    expect(equipmentTypeEnum).toBeDefined();
    expect(equipmentTypeEnum.enumValues).toEqual(["deep", "medium", "shallow", "queen_excluder", "double_screen", "inner_cover", "outer_cover", "bottom_board", "entrance_reducer", "feeder", "other"]);
  });

  it("should export frameTypeEnum", () => {
    expect(frameTypeEnum).toBeDefined();
    expect(frameTypeEnum.enumValues).toEqual(["wax_foundation", "plastic", "foundationless", "drawn_comb"]);
  });
});
