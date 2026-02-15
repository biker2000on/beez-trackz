import { Queue, Worker, Job, type ConnectionOptions } from "bullmq";
import { db } from "@/db";
import { mediaFiles } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getAIProvider } from "@/lib/ai";
import { parseTranscription } from "@/lib/ai/transcription-parser";
import fs from "fs/promises";

const QUEUE_NAME = "transcription";

function getRedisConnection(): ConnectionOptions {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const url = new URL(redisUrl);
  return {
    host: url.hostname || "localhost",
    port: parseInt(url.port || "6379", 10),
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
}

export const transcriptionQueue = new Queue(QUEUE_NAME, {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export interface TranscriptionJobData {
  mediaFileId: string;
  audioPath: string;
  mode: "single" | "batch";
}

export function createTranscriptionWorker() {
  return new Worker<TranscriptionJobData>(
    QUEUE_NAME,
    async (job: Job<TranscriptionJobData>) => {
      const { mediaFileId, audioPath, mode } = job.data;

      // Step 1: Update status to "processing"
      await db
        .update(mediaFiles)
        .set({
          transcriptionStatus: "processing",
          updatedAt: new Date(),
        })
        .where(eq(mediaFiles.id, mediaFileId));

      try {
        // Step 2: Read audio file from disk
        const audioBuffer = await fs.readFile(audioPath);

        // Step 3: Transcribe audio using AI provider
        const transcriptionProvider = await getAIProvider("transcription");
        const rawText = await transcriptionProvider.transcribe(audioBuffer);

        // Step 4: Parse transcription to extract structured fields
        const parsedResult = await parseTranscription(rawText, mode);

        // Step 5: Save transcription text and parsed data to mediaFile record
        await db
          .update(mediaFiles)
          .set({
            transcriptionText: rawText,
            transcriptionStatus: "complete",
            updatedAt: new Date(),
          })
          .where(eq(mediaFiles.id, mediaFileId));

        return parsedResult;
      } catch (error) {
        // Step 6: Update status to "failed" on error
        const errorMessage =
          error instanceof Error ? error.message : "Unknown transcription error";

        await db
          .update(mediaFiles)
          .set({
            transcriptionStatus: "failed",
            transcriptionText: `Error: ${errorMessage}`,
            updatedAt: new Date(),
          })
          .where(eq(mediaFiles.id, mediaFileId));

        throw error;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 1, // Transcription jobs are heavy; process one at a time
    }
  );
}
