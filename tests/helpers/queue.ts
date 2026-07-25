import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { randomUUID } from 'crypto';

export function makeTestQueue() {
  const name = `test-${randomUUID()}`;
  const conn = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue(name, { connection: conn });
  return {
    queue,
    async cleanup() {
      try {
        await queue.obliterate({ force: true });
      } finally {
        await conn.quit();
      }
    },
  };
}