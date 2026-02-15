import { describe, it, expect } from "vitest";

describe("feeding actions", () => {
  it("should export createFeeding", async () => {
    const mod = await import("@/actions/feedings");
    expect(mod.createFeeding).toBeDefined();
    expect(typeof mod.createFeeding).toBe("function");
  });

  it("should export markFeedingEmpty", async () => {
    const mod = await import("@/actions/feedings");
    expect(mod.markFeedingEmpty).toBeDefined();
    expect(typeof mod.markFeedingEmpty).toBe("function");
  });

  it("should export deleteFeeding", async () => {
    const mod = await import("@/actions/feedings");
    expect(mod.deleteFeeding).toBeDefined();
    expect(typeof mod.deleteFeeding).toBe("function");
  });

  it("should export getFeedingsForHive", async () => {
    const mod = await import("@/actions/feedings");
    expect(mod.getFeedingsForHive).toBeDefined();
    expect(typeof mod.getFeedingsForHive).toBe("function");
  });

  it("should export getActiveFeedings", async () => {
    const mod = await import("@/actions/feedings");
    expect(mod.getActiveFeedings).toBeDefined();
    expect(typeof mod.getActiveFeedings).toBe("function");
  });
});
