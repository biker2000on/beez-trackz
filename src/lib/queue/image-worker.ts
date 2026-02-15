import { type Job } from "bullmq";
import { db } from "@/db";
import { photos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { processImage } from "@/lib/image-processing";
import { createImageWorker, type ImageJobData } from "./setup";

async function handleImageJob(job: Job<ImageJobData>) {
  const { photoId, inputPath, outputDir } = job.data;

  const { thumbnailPath, mediumPath } = await processImage(inputPath, outputDir);

  await db
    .update(photos)
    .set({ thumbnailPath, mediumPath })
    .where(eq(photos.id, photoId));

  return { thumbnailPath, mediumPath };
}

export const imageWorker = createImageWorker(handleImageJob);

imageWorker.on("completed", (job) => {
  console.log(`Image processing completed for job ${job.id}`);
});

imageWorker.on("failed", (job, err) => {
  console.error(`Image processing failed for job ${job?.id}:`, err.message);
});
