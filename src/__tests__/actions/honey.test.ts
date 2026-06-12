import { describe, it, expect } from "vitest";

describe("honey actions (ledger model)", () => {
  const expectedExports = [
    "createHarvest",
    "getHarvests",
    "recordJarring",
    "recordBulkMovement",
    "recordGiveAway",
    "adjustJarCounts",
    "deleteMovement",
    "recordSale",
    "deleteSale",
    "getSales",
    "getSaleLocations",
    "getJarInventory",
    "getHoneyOverview",
    "getHoneyTimeline",
  ];

  for (const name of expectedExports) {
    it(`should export ${name}`, async () => {
      const mod = await import("@/actions/honey");
      expect(mod[name as keyof typeof mod]).toBeDefined();
      expect(typeof mod[name as keyof typeof mod]).toBe("function");
    });
  }
});
