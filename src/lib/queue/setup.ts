import { Queue, Worker, type Processor, type ConnectionOptions } from "bullmq";

const QUEUE_NAME = "image-processing";

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

export const imageProcessingQueue = new Queue(QUEUE_NAME, {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export interface ImageJobData {
  photoId: string;
  inputPath: string;
  outputDir: string;
}

export function createImageWorker(processor: Processor<ImageJobData>) {
  return new Worker<ImageJobData>(QUEUE_NAME, processor, {
    connection: getRedisConnection(),
    concurrency: 2,
  });
}
