import { describe, it, expect } from "vitest";

describe("equipment-v2 actions", () => {
  const expectedExports = [
    "getEquipmentTypes",
    "createEquipmentType",
    "getEquipmentStock",
    "adjustStock",
    "createStock",
    "deployEquipment",
    "removeDeployment",
    "getDeploymentsForHive",
    "getFrameSummary",
    "bulkAdjustStock",
    "updateStock",
    "getActiveDeployments",
  ];

  for (const name of expectedExports) {
    it(`should export ${name}`, async () => {
      const mod = await import("@/actions/equipment-v2");
      expect(mod[name as keyof typeof mod]).toBeDefined();
      expect(typeof mod[name as keyof typeof mod]).toBe("function");
    });
  }
});
