import { describe, it, expect } from "vitest";

describe("hive actions", () => {
  it("should export createHive", async () => {
    const mod = await import("@/actions/hives");
    expect(mod.createHive).toBeDefined();
    expect(typeof mod.createHive).toBe("function");
  });

  it("should export updateHive", async () => {
    const mod = await import("@/actions/hives");
    expect(mod.updateHive).toBeDefined();
    expect(typeof mod.updateHive).toBe("function");
  });

  it("should export moveHive", async () => {
    const mod = await import("@/actions/hives");
    expect(mod.moveHive).toBeDefined();
    expect(typeof mod.moveHive).toBe("function");
  });

  it("should export deleteHive", async () => {
    const mod = await import("@/actions/hives");
    expect(mod.deleteHive).toBeDefined();
    expect(typeof mod.deleteHive).toBe("function");
  });

  it("should export getHives", async () => {
    const mod = await import("@/actions/hives");
    expect(mod.getHives).toBeDefined();
    expect(typeof mod.getHives).toBe("function");
  });

  it("should export getHive", async () => {
    const mod = await import("@/actions/hives");
    expect(mod.getHive).toBeDefined();
    expect(typeof mod.getHive).toBe("function");
  });

  it("should export getHiveLocationHistory", async () => {
    const mod = await import("@/actions/hives");
    expect(mod.getHiveLocationHistory).toBeDefined();
    expect(typeof mod.getHiveLocationHistory).toBe("function");
  });

  it("should export getHivesForApiary", async () => {
    const mod = await import("@/actions/hives");
    expect(mod.getHivesForApiary).toBeDefined();
    expect(typeof mod.getHivesForApiary).toBe("function");
  });
});
