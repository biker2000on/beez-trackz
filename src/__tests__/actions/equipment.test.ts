import { describe, it, expect } from "vitest";

describe("equipment actions", () => {
  it("should export createEquipment", async () => {
    const mod = await import("@/actions/equipment");
    expect(mod.createEquipment).toBeDefined();
    expect(typeof mod.createEquipment).toBe("function");
  });

  it("should export updateEquipment", async () => {
    const mod = await import("@/actions/equipment");
    expect(mod.updateEquipment).toBeDefined();
    expect(typeof mod.updateEquipment).toBe("function");
  });

  it("should export deleteEquipment", async () => {
    const mod = await import("@/actions/equipment");
    expect(mod.deleteEquipment).toBeDefined();
    expect(typeof mod.deleteEquipment).toBe("function");
  });

  it("should export moveEquipment", async () => {
    const mod = await import("@/actions/equipment");
    expect(mod.moveEquipment).toBeDefined();
    expect(typeof mod.moveEquipment).toBe("function");
  });

  it("should export getEquipmentForHive", async () => {
    const mod = await import("@/actions/equipment");
    expect(mod.getEquipmentForHive).toBeDefined();
    expect(typeof mod.getEquipmentForHive).toBe("function");
  });

  it("should export getEquipmentInStorage", async () => {
    const mod = await import("@/actions/equipment");
    expect(mod.getEquipmentInStorage).toBeDefined();
    expect(typeof mod.getEquipmentInStorage).toBe("function");
  });

  it("should export getAllEquipment", async () => {
    const mod = await import("@/actions/equipment");
    expect(mod.getAllEquipment).toBeDefined();
    expect(typeof mod.getAllEquipment).toBe("function");
  });

  it("should export getFrameShortage", async () => {
    const mod = await import("@/actions/equipment");
    expect(mod.getFrameShortage).toBeDefined();
    expect(typeof mod.getFrameShortage).toBe("function");
  });
});
