import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import { photos, mediaFiles, mediaOwnerTypeEnum, transcriptionStatusEnum } from "@/db/schema";

describe("media schema", () => {
  it("should export photos table", () => {
    expect(photos).toBeDefined();
    expect(getTableName(photos)).toBe("photos");
  });

  it("should export mediaFiles table", () => {
    expect(mediaFiles).toBeDefined();
    expect(getTableName(mediaFiles)).toBe("media_files");
  });

  it("should export mediaOwnerTypeEnum", () => {
    expect(mediaOwnerTypeEnum).toBeDefined();
    expect(mediaOwnerTypeEnum.enumValues).toEqual(["hive", "apiary", "inspection"]);
  });

  it("should export transcriptionStatusEnum", () => {
    expect(transcriptionStatusEnum).toBeDefined();
    expect(transcriptionStatusEnum.enumValues).toEqual(["pending", "processing", "complete", "failed"]);
  });
});
