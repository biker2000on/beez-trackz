"use server";

import { requireSession } from "@/lib/require-session";
import { db } from "@/db";
import { mediaFiles, inspections } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import fs from "fs/promises";
import path from "path";
import { transcriptionQueue } from "@/lib/queue/transcription";
import type { ParsedInspection, TranscriptionResult } from "@/lib/ai/transcription-parser";
import { parseTranscription } from "@/lib/ai/transcription-parser";
import { normalizeFormData } from "@/lib/form-values";

const AUDIO_DIR = path.resolve("./data/audio");

export async function uploadAudioForTranscription(formData: FormData) {
  await requireSession();
  formData = normalizeFormData(formData);
  const audioBlob = formData.get("audioBlob") as File | null;
  const ownerType = formData.get("ownerType") as string;
  const ownerId = formData.get("ownerId") as string;
  const mode = (formData.get("mode") as "single" | "batch") || "single";

  if (!audioBlob || audioBlob.size === 0) {
    return { error: "Audio file is required" };
  }
  if (!ownerType) {
    return { error: "Owner type is required" };
  }
  if (!ownerId) {
    return { error: "Owner ID is required" };
  }

  // Create DB record first to get the ID
  const [mediaFile] = await db
    .insert(mediaFiles)
    .values({
      originalUrl: "", // Will be updated with actual path
      transcriptionStatus: "pending",
      ownerType: ownerType as "hive" | "apiary" | "inspection",
      ownerId,
    })
    .returning();

  // Save audio file to disk
  await fs.mkdir(AUDIO_DIR, { recursive: true });
  const audioPath = path.join(AUDIO_DIR, `${mediaFile.id}.webm`);

  const buffer = Buffer.from(await audioBlob.arrayBuffer());
  await fs.writeFile(audioPath, buffer);

  // Update the DB record with the actual file path
  await db
    .update(mediaFiles)
    .set({ originalUrl: audioPath, updatedAt: new Date() })
    .where(eq(mediaFiles.id, mediaFile.id));

  // Enqueue transcription job
  await transcriptionQueue.add("transcribe", {
    mediaFileId: mediaFile.id,
    audioPath,
    mode,
  });

  return { success: true, mediaFileId: mediaFile.id };
}

export async function getTranscriptionStatus(mediaFileId: string) {
  await requireSession();
  const result = await db
    .select()
    .from(mediaFiles)
    .where(eq(mediaFiles.id, mediaFileId))
    .limit(1);

  const mediaFile = result[0];
  if (!mediaFile) {
    return { error: "Media file not found" };
  }

  // If complete, attempt to parse the stored transcription text for structured data
  let parsedData: TranscriptionResult | null = null;
  if (
    mediaFile.transcriptionStatus === "complete" &&
    mediaFile.transcriptionText &&
    !mediaFile.transcriptionText.startsWith("Error:")
  ) {
    // We store raw text in DB; re-parse is avoided by caching on the client side
    // But for API simplicity, we return what we have
    parsedData = {
      rawText: mediaFile.transcriptionText,
      inspections: [], // Client should call parseTranscriptionText for structured data
    };
  }

  return {
    id: mediaFile.id,
    status: mediaFile.transcriptionStatus,
    rawText: mediaFile.transcriptionText,
    parsedData,
    createdAt: mediaFile.createdAt,
    updatedAt: mediaFile.updatedAt,
  };
}

export async function getTranscriptionsForOwner(
  ownerType: string,
  ownerId: string
) {
  await requireSession();
  return db
    .select()
    .from(mediaFiles)
    .where(
      and(
        eq(
          mediaFiles.ownerType,
          ownerType as "hive" | "apiary" | "inspection"
        ),
        eq(mediaFiles.ownerId, ownerId)
      )
    )
    .orderBy(desc(mediaFiles.createdAt));
}

export async function parseTranscriptionText(
  rawText: string,
  mode: "single" | "batch"
): Promise<TranscriptionResult> {
  await requireSession();
  return parseTranscription(rawText, mode);
}

export async function confirmTranscription(
  mediaFileId: string,
  confirmedInspections: ParsedInspection[]
) {
  await requireSession();
  // Verify the media file exists
  const mediaResult = await db
    .select()
    .from(mediaFiles)
    .where(eq(mediaFiles.id, mediaFileId))
    .limit(1);

  const mediaFile = mediaResult[0];
  if (!mediaFile) {
    return { error: "Media file not found" };
  }

  if (confirmedInspections.length === 0) {
    return { error: "No inspections to confirm" };
  }

  // Create inspection records from the confirmed parsed data
  const createdInspections = [];
  for (const inspection of confirmedInspections) {
    // For single mode, use the media file's ownerId as the hiveId
    const hiveId = mediaFile.ownerId;

    const [created] = await db
      .insert(inspections)
      .values({
        hiveId,
        date: new Date(),
        queenSeen: inspection.queenSeen ?? null,
        queenHealth: inspection.queenHealth ?? null,
        broodPattern: inspection.broodPattern ?? null,
        storesHoney: inspection.storesHoney ?? null,
        storesPollen: inspection.storesPollen ?? null,
        temperament: inspection.temperament ?? null,
        pests: inspection.pests ?? null,
        treatments: inspection.treatments ?? null,
        notes: inspection.notes ?? null,
        sourceMedia: {
          mediaFileId,
          hiveReference: inspection.hiveReference,
          rawText: mediaFile.transcriptionText,
        },
      })
      .returning();

    createdInspections.push(created);
  }

  // Revalidate relevant paths
  revalidatePath(`/hives/${mediaFile.ownerId}`);
  revalidatePath("/dashboard");

  return {
    success: true,
    inspectionIds: createdInspections.map((i) => i.id),
  };
}

export async function confirmBatchTranscription(
  mediaFileId: string,
  confirmedInspections: Array<ParsedInspection & { hiveId: string }>
) {
  await requireSession();
  // Verify the media file exists
  const mediaResult = await db
    .select()
    .from(mediaFiles)
    .where(eq(mediaFiles.id, mediaFileId))
    .limit(1);

  const mediaFile = mediaResult[0];
  if (!mediaFile) {
    return { error: "Media file not found" };
  }

  if (confirmedInspections.length === 0) {
    return { error: "No inspections to confirm" };
  }

  // Create inspection records from the confirmed parsed data
  const createdInspections = [];
  const affectedHiveIds = new Set<string>();

  for (const inspection of confirmedInspections) {
    const { hiveId, ...inspectionData } = inspection;

    if (!hiveId) {
      return { error: "Hive ID is required for each inspection" };
    }

    affectedHiveIds.add(hiveId);

    const [created] = await db
      .insert(inspections)
      .values({
        hiveId,
        date: new Date(),
        queenSeen: inspectionData.queenSeen ?? null,
        queenHealth: inspectionData.queenHealth ?? null,
        broodPattern: inspectionData.broodPattern ?? null,
        storesHoney: inspectionData.storesHoney ?? null,
        storesPollen: inspectionData.storesPollen ?? null,
        temperament: inspectionData.temperament ?? null,
        pests: inspectionData.pests ?? null,
        treatments: inspectionData.treatments ?? null,
        notes: inspectionData.notes ?? null,
        sourceMedia: {
          mediaFileId,
          hiveReference: inspectionData.hiveReference,
          rawText: mediaFile.transcriptionText,
        },
      })
      .returning();

    createdInspections.push(created);
  }

  // Revalidate relevant paths for all affected hives
  affectedHiveIds.forEach((hiveId) => {
    revalidatePath(`/hives/${hiveId}`);
  });
  revalidatePath("/dashboard");

  return {
    success: true,
    inspectionIds: createdInspections.map((i) => i.id),
  };
}
