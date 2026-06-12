/**
 * Background worker entrypoint. Runs as a separate container/process from
 * the Next.js server (compose service `worker`, `node worker.js`).
 *
 * Without this process nothing consumes the BullMQ queues — the web app
 * only enqueues. Bundled into .next/standalone/worker.js by esbuild during
 * the Docker build.
 */
import { imageWorker } from "@/lib/queue/image-worker";
import { createTranscriptionWorker } from "@/lib/queue/transcription";
import {
  createRecommendationWorker,
  scheduleRecommendationCheck,
} from "@/lib/queue/recommendations";

async function main() {
  const transcriptionWorker = createTranscriptionWorker();
  const recommendationWorker = createRecommendationWorker();
  await scheduleRecommendationCheck();

  console.log(
    "[worker] processing queues: image-processing, transcription, recommendation-check"
  );

  const workers = [imageWorker, transcriptionWorker, recommendationWorker];
  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, closing workers...`);
    await Promise.allSettled(workers.map((w) => w.close()));
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[worker] fatal error:", error);
  process.exit(1);
});
