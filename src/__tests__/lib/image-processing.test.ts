import { describe, it, expect, vi } from "vitest";
import path from "path";

// Mock sharp before importing the module
vi.mock("sharp", () => {
  const mockSharpInstance = {
    rotate: vi.fn().mockReturnThis(),
    resize: vi.fn().mockReturnThis(),
    toFile: vi.fn().mockResolvedValue({}),
  };
  return { default: vi.fn(() => mockSharpInstance) };
});

describe("image-processing", () => {
  it("should export processImage as a function", async () => {
    const mod = await import("@/lib/image-processing");
    expect(mod.processImage).toBeDefined();
    expect(typeof mod.processImage).toBe("function");
  });

  it("should generate correct thumbnail and medium paths", async () => {
    const { processImage } = await import("@/lib/image-processing");

    const inputPath = "/data/photos/hive/abc/photo.jpg";
    const outputDir = "/data/photos/hive/abc";

    const result = await processImage(inputPath, outputDir);

    expect(result.thumbnailPath).toBe(
      path.join(outputDir, "photo_thumb.jpg")
    );
    expect(result.mediumPath).toBe(
      path.join(outputDir, "photo_medium.jpg")
    );
  });

  it("should handle files with no extension", async () => {
    const { processImage } = await import("@/lib/image-processing");

    const inputPath = "/data/photos/hive/abc/photo";
    const outputDir = "/data/photos/hive/abc";

    const result = await processImage(inputPath, outputDir);

    expect(result.thumbnailPath).toBe(
      path.join(outputDir, "photo_thumb")
    );
    expect(result.mediumPath).toBe(
      path.join(outputDir, "photo_medium")
    );
  });

  it("should call sharp with correct resize widths", async () => {
    const sharp = (await import("sharp")).default;
    const { processImage } = await import("@/lib/image-processing");

    await processImage("/input/test.png", "/output");

    // sharp is called twice (thumbnail + medium)
    expect(sharp).toHaveBeenCalledWith("/input/test.png");

    const instance = (sharp as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    // rotate called for EXIF handling
    expect(instance.rotate).toHaveBeenCalled();
    // resize called with appropriate widths
    expect(instance.resize).toHaveBeenCalledWith({
      width: 200,
      withoutEnlargement: true,
    });
  });
});
