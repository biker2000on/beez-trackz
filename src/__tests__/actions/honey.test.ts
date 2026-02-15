import { describe, it, expect } from "vitest";

describe("honey actions", () => {
  it("should export createHarvest", async () => {
    const mod = await import("@/actions/honey");
    expect(mod.createHarvest).toBeDefined();
    expect(typeof mod.createHarvest).toBe("function");
  });

  it("should export createJarring", async () => {
    const mod = await import("@/actions/honey");
    expect(mod.createJarring).toBeDefined();
    expect(typeof mod.createJarring).toBe("function");
  });

  it("should export createSale", async () => {
    const mod = await import("@/actions/honey");
    expect(mod.createSale).toBeDefined();
    expect(typeof mod.createSale).toBe("function");
  });

  it("should export getHarvests", async () => {
    const mod = await import("@/actions/honey");
    expect(mod.getHarvests).toBeDefined();
    expect(typeof mod.getHarvests).toBe("function");
  });

  it("should export getHoneyInventory", async () => {
    const mod = await import("@/actions/honey");
    expect(mod.getHoneyInventory).toBeDefined();
    expect(typeof mod.getHoneyInventory).toBe("function");
  });

  it("should export getSales", async () => {
    const mod = await import("@/actions/honey");
    expect(mod.getSales).toBeDefined();
    expect(typeof mod.getSales).toBe("function");
  });

  it("should export getHoneyDashboard", async () => {
    const mod = await import("@/actions/honey");
    expect(mod.getHoneyDashboard).toBeDefined();
    expect(typeof mod.getHoneyDashboard).toBe("function");
  });
});
