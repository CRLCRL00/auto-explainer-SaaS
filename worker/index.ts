import { createWorker } from '@/lib/queue';
import { runPipeline } from './pipeline';
import { logger } from '@/lib/logger';

const worker = createWorker(async (job) => {
  const { jobId, phase } = job.data;
  logger.info({ jobId, phase }, 'worker picked job');
  await runPipeline(jobId);
  return { ok: true };
});

worker.on('completed', (job) => {
  logger.info({ jobId: job.data.jobId, phase: job.data.phase }, 'job completed');
});

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.data.jobId, err: err.message }, 'job failed');
});

logger.info('worker started, waiting for jobs…');

// 优雅退出
process.on('SIGINT', async () => {
  logger.info('SIGINT received, closing worker…');
  await worker.close();
  process.exit(0);
});
