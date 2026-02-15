import { describe, it, expect } from "vitest";

describe("queen actions", () => {
  it("should export createQueen", async () => {
    const mod = await import("@/actions/queens");
    expect(mod.createQueen).toBeDefined();
    expect(typeof mod.createQueen).toBe("function");
  });

  it("should export updateQueen", async () => {
    const mod = await import("@/actions/queens");
    expect(mod.updateQueen).toBeDefined();
    expect(typeof mod.updateQueen).toBe("function");
  });

  it("should export getQueensForHive", async () => {
    const mod = await import("@/actions/queens");
    expect(mod.getQueensForHive).toBeDefined();
    expect(typeof mod.getQueensForHive).toBe("function");
  });

  it("should export getQueen", async () => {
    const mod = await import("@/actions/queens");
    expect(mod.getQueen).toBeDefined();
    expect(typeof mod.getQueen).toBe("function");
  });

  it("should export getAllQueens", async () => {
    const mod = await import("@/actions/queens");
    expect(mod.getAllQueens).toBeDefined();
    expect(typeof mod.getAllQueens).toBe("function");
  });

  it("should export getQueenLineage", async () => {
    const mod = await import("@/actions/queens");
    expect(mod.getQueenLineage).toBeDefined();
    expect(typeof mod.getQueenLineage).toBe("function");
  });

  it("should export getQueenDescendants", async () => {
    const mod = await import("@/actions/queens");
    expect(mod.getQueenDescendants).toBeDefined();
    expect(typeof mod.getQueenDescendants).toBe("function");
  });
});
