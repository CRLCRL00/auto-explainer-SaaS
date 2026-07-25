import { Queue, Worker, type Processor } from 'bullmq';
import IORedis from 'ioredis';
import { getEnv } from './env';
import { logger } from './logger';

let connection: IORedis | null = null;

export function getRedis() {
  if (connection) return connection;
  const env = getEnv();
  connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', (err) => logger.error({ err }, 'redis error'));
  return connection;
}

export const JOB_QUEUE_NAME = 'video-jobs';

let queueInstance: Queue | null = null;

export function getJobQueue(): Queue {
  if (queueInstance) return queueInstance;
  queueInstance = new Queue(JOB_QUEUE_NAME, { connection: getRedis() });
  return queueInstance;
}

export interface JobData {
  jobId: string;
  phase: string;
}

export function createWorker(processor: Processor<JobData>) {
  return new Worker<JobData>(JOB_QUEUE_NAME, processor, {
    connection: getRedis(),
    concurrency: 1,  // v0.0.1 单 worker 进程
  });
}