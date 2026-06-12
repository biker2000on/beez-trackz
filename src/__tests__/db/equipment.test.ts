import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  equipmentTypes,
  equipmentStock,
  equipmentStockAdjustments,
  equipmentDeployments,
} from "@/db/schema";

describe("equipment schema (v2)", () => {
  it("should export equipment inventory tables", () => {
    expect(getTableName(equipmentTypes)).toBe("equipment_types");
    expect(getTableName(equipmentStock)).toBe("equipment_stock");
    expect(getTableName(equipmentStockAdjustments)).toBe("equipment_stock_adjustments");
    expect(getTableName(equipmentDeployments)).toBe("equipment_deployments");
  });
});
