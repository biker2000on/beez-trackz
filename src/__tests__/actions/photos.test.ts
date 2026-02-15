import { describe, it, expect } from "vitest";

describe("photo actions", () => {
  it("should export uploadPhoto", async () => {
    const mod = await import("@/actions/photos");
    expect(mod.uploadPhoto).toBeDefined();
    expect(typeof mod.uploadPhoto).toBe("function");
  });

  it("should export deletePhoto", async () => {
    const mod = await import("@/actions/photos");
    expect(mod.deletePhoto).toBeDefined();
    expect(typeof mod.deletePhoto).toBe("function");
  });

  it("should export getPhotosForOwner", async () => {
    const mod = await import("@/actions/photos");
    expect(mod.getPhotosForOwner).toBeDefined();
    expect(typeof mod.getPhotosForOwner).toBe("function");
  });

  it("should export updatePhotoCaption", async () => {
    const mod = await import("@/actions/photos");
    expect(mod.updatePhotoCaption).toBeDefined();
    expect(typeof mod.updatePhotoCaption).toBe("function");
  });
});
