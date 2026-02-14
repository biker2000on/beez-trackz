import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import { honeyHarvests, honeyInventory, honeySales } from "@/db/schema";

describe("honey schema", () => {
  it("should export honeyHarvests table", () => {
    expect(honeyHarvests).toBeDefined();
    expect(getTableName(honeyHarvests)).toBe("honey_harvests");
  });

  it("should export honeyInventory table", () => {
    expect(honeyInventory).toBeDefined();
    expect(getTableName(honeyInventory)).toBe("honey_inventory");
  });

  it("should export honeySales table", () => {
    expect(honeySales).toBeDefined();
    expect(getTableName(honeySales)).toBe("honey_sales");
  });
});
