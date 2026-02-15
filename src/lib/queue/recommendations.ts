import { Queue, Worker, type ConnectionOptions } from "bullmq";

const QUEUE_NAME = "recommendation-check";

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

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export const recommendationQueue = new Queue(QUEUE_NAME, {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 50,
    removeOnFail: 100,
  },
});

// ---------------------------------------------------------------------------
// Repeatable job — every 6 hours
// ---------------------------------------------------------------------------

export async function scheduleRecommendationCheck() {
  // Remove existing repeatable jobs to avoid duplicates on restart
  const existing = await recommendationQueue.getRepeatableJobs();
  for (const job of existing) {
    await recommendationQueue.removeRepeatableByKey(job.key);
  }

  await recommendationQueue.add(
    "scheduled-recommendation-check",
    {},
    {
      repeat: {
        // Every 6 hours
        pattern: "0 */6 * * *",
      },
    }
  );
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export function createRecommendationWorker() {
  return new Worker(
    QUEUE_NAME,
    async () => {
      // Dynamic import to keep the engine lazy-loaded
      const { runRecommendationCheck } = await import(
        "@/lib/recommendations/engine"
      );
      const result = await runRecommendationCheck({ enrichWithAI: false });

      console.log(
        `[recommendations] check complete: ${result.created} created, ${result.skippedDuplicates} skipped`,
        result.errors.length > 0 ? `errors: ${result.errors.join("; ")}` : ""
      );

      return result;
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
    }
  );
}
