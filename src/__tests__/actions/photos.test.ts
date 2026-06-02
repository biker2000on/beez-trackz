import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/queue/setup", () => ({
  imageProcessingQueue: {
    add: vi.fn(),
  },
  createImageWorker: vi.fn(),
}));

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
