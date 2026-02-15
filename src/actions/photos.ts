"use server";

import { db } from "@/db";
import { photos } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import fs from "fs/promises";
import path from "path";
import { imageProcessingQueue } from "@/lib/queue/setup";

const DATA_DIR = path.resolve("./data/photos");

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function uploadPhoto(_prevState: unknown, formData: FormData) {
  const file = formData.get("file") as File | null;
  const ownerType = formData.get("ownerType") as string;
  const ownerId = formData.get("ownerId") as string;
  const caption = formData.get("caption") as string;
  const tagsJson = formData.get("tags") as string;

  if (!file || file.size === 0) {
    return { error: "Photo file is required" };
  }
  if (!ownerType) {
    return { error: "Owner type is required" };
  }
  if (!ownerId) {
    return { error: "Owner ID is required" };
  }

  // Build storage directory: ./data/photos/{ownerType}/{ownerId}/
  const ownerDir = path.join(DATA_DIR, ownerType, ownerId);
  await fs.mkdir(ownerDir, { recursive: true });

  // Generate unique filename
  const timestamp = Date.now();
  const safeName = sanitizeFilename(file.name);
  const filename = `${timestamp}_${safeName}`;
  const originalPath = path.join(ownerDir, filename);

  // Write file to disk
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(originalPath, buffer);

  // Parse tags
  let tags: string[] | null = null;
  if (tagsJson) {
    try {
      tags = JSON.parse(tagsJson);
    } catch {
      tags = null;
    }
  }

  // Create DB record
  const [photo] = await db
    .insert(photos)
    .values({
      ownerType: ownerType as "hive" | "apiary" | "inspection",
      ownerId,
      originalPath,
      caption: caption?.trim() || null,
      tags,
      takenDate: new Date(),
    })
    .returning();

  // Enqueue image processing job
  await imageProcessingQueue.add("process-image", {
    photoId: photo.id,
    inputPath: originalPath,
    outputDir: ownerDir,
  });

  revalidatePath(`/${ownerType}s/${ownerId}`);
  return { success: true, photoId: photo.id };
}

export async function deletePhoto(id: string) {
  // Fetch the photo to get file paths
  const existing = await db
    .select()
    .from(photos)
    .where(eq(photos.id, id))
    .limit(1);

  const photo = existing[0];
  if (!photo) {
    return { error: "Photo not found" };
  }

  // Remove files from disk (ignore errors if files don't exist)
  const pathsToDelete = [
    photo.originalPath,
    photo.thumbnailPath,
    photo.mediumPath,
  ].filter(Boolean) as string[];

  await Promise.all(
    pathsToDelete.map((p) => fs.unlink(p).catch(() => {}))
  );

  // Remove from DB
  await db.delete(photos).where(eq(photos.id, id));

  revalidatePath(`/${photo.ownerType}s/${photo.ownerId}`);
  return { success: true };
}

export async function getPhotosForOwner(ownerType: string, ownerId: string) {
  return db
    .select()
    .from(photos)
    .where(and(eq(photos.ownerType, ownerType as "hive" | "apiary" | "inspection"), eq(photos.ownerId, ownerId)));
}

export async function updatePhotoCaption(
  id: string,
  caption: string,
  tags: string[]
) {
  const existing = await db
    .select({ ownerType: photos.ownerType, ownerId: photos.ownerId })
    .from(photos)
    .where(eq(photos.id, id))
    .limit(1);

  const photo = existing[0];
  if (!photo) {
    return { error: "Photo not found" };
  }

  await db
    .update(photos)
    .set({
      caption: caption?.trim() || null,
      tags,
    })
    .where(eq(photos.id, id));

  revalidatePath(`/${photo.ownerType}s/${photo.ownerId}`);
  return { success: true };
}
