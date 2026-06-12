import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  honeyHarvests,
  honeySales,
  honeyMovements,
  honeySaleItems,
  jarSizes,
} from "@/db/schema";

describe("honey schema (ledger model)", () => {
  it("should export harvest and sales tables", () => {
    expect(getTableName(honeyHarvests)).toBe("honey_harvests");
    expect(getTableName(honeySales)).toBe("honey_sales");
  });

  it("should export ledger tables", () => {
    expect(getTableName(honeyMovements)).toBe("honey_movements");
    expect(getTableName(honeySaleItems)).toBe("honey_sale_items");
    expect(getTableName(jarSizes)).toBe("jar_sizes");
  });
});
