import { describe, it, expect } from "vitest";

describe("inspection actions", () => {
  it("should export createInspection", async () => {
    const mod = await import("@/actions/inspections");
    expect(mod.createInspection).toBeDefined();
    expect(typeof mod.createInspection).toBe("function");
  });

  it("should export updateInspection", async () => {
    const mod = await import("@/actions/inspections");
    expect(mod.updateInspection).toBeDefined();
    expect(typeof mod.updateInspection).toBe("function");
  });

  it("should export deleteInspection", async () => {
    const mod = await import("@/actions/inspections");
    expect(mod.deleteInspection).toBeDefined();
    expect(typeof mod.deleteInspection).toBe("function");
  });

  it("should export getInspectionsForHive", async () => {
    const mod = await import("@/actions/inspections");
    expect(mod.getInspectionsForHive).toBeDefined();
    expect(typeof mod.getInspectionsForHive).toBe("function");
  });

  it("should export getInspection", async () => {
    const mod = await import("@/actions/inspections");
    expect(mod.getInspection).toBeDefined();
    expect(typeof mod.getInspection).toBe("function");
  });

  it("should export getRecentInspections", async () => {
    const mod = await import("@/actions/inspections");
    expect(mod.getRecentInspections).toBeDefined();
    expect(typeof mod.getRecentInspections).toBe("function");
  });
});
