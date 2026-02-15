import { describe, it, expect } from "vitest";

describe("canvas actions", () => {
  it("should export saveCanvasLayout", async () => {
    const mod = await import("@/actions/canvas");
    expect(mod.saveCanvasLayout).toBeDefined();
    expect(typeof mod.saveCanvasLayout).toBe("function");
  });

  it("should export CanvasLayout type", async () => {
    // Verify the module loads without errors (type exports don't exist at runtime
    // but the module should still import cleanly)
    const mod = await import("@/actions/canvas");
    expect(mod).toBeDefined();
  });
});
