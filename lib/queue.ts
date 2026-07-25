import { Queue, Worker, type Processor } from 'bullmq';
import IORedis from 'ioredis';
import { getEnv } from './env';
import { logger } from './logger';

// HMR-safe singleton (Next.js dev Fast Refresh): stash on globalThis
// so module re-evaluation doesn't leak duplicate IORedis instances.
const g = globalThis as unknown as { __ioredis?: IORedis; __bullQueue?: Queue };

export function getRedis(): IORedis {
  if (g.__ioredis) return g.__ioredis;
  const env = getEnv();
  const conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  conn.on('error', (err) => logger.error({ err }, 'redis error'));
  g.__ioredis = conn;
  return conn;
}

export const JOB_QUEUE_NAME = 'video-jobs';

export function getJobQueue(): Queue<JobData> {
  if (g.__bullQueue) return g.__bullQueue as Queue<JobData>;
  g.__bullQueue = new Queue<JobData>(JOB_QUEUE_NAME, { connection: getRedis() });
  return g.__bullQueue as Queue<JobData>;
}

export interface JobData {
  jobId: string;
  phase: string;
}

// BullMQ 官方要求 Queue 和 Worker 必须用独立连接（Worker 跑 BRPOP 会阻塞共享连接）。
// 在 createWorker 内新建 connection，调用方负责 quit。
export function createWorker(processor: Processor<JobData>): Worker<JobData> {
  const env = getEnv();
  const conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  conn.on('error', (err) => logger.error({ err }, 'worker redis error'));
  return new Worker<JobData>(JOB_QUEUE_NAME, processor, {
    connection: conn,
    concurrency: 1,  // v0.0.1 单 worker 进程
  });
}