// Trigger.dev v4 task definitions — picked up by Trigger.dev worker runtime
// (`npx trigger.dev dev` for local; self-hosted `triggerdotdev/trigger.dev` for prod).
//
// PR3 切流: BullMQ worker process 不再被启; Trigger.dev worker runtime 拉取本文件
// 的 processVideoJob task 定义, 替代 BullMQ Worker.
//
// Dual-run in app/api/jobs/route.ts still submits BullMQ enqueue as the
// fallback tail (even-byte jobId), keeping the defence-in-depth until PR4
// removes BullMQ entirely.

import { logger } from '@/lib/logger';
import { runPipeline } from '@/worker/pipeline';
import { task } from '@trigger.dev/sdk/v3';

export const processVideoJob = task({
  id: 'process-video-job',
  // @trigger.dev/sdk v4.5 第二个参数是 task context wrapper object — 必须
  // 解构 `{ ctx }` 才能拿到 `ctx.run`. 之前评论说 'SDK v3 直接 ctx' 不再适用
  // v4 (v4 把 ctx 包装一层了). 见 lib/trigger.ts triggerJob() 同样模式.
  run: async (
    payload: { jobId: string; phase?: string },
    { ctx },
  ) => {
    logger.info(
      { jobId: payload.jobId, runId: ctx.run.id },
      'trigger.dev task started: process-video-job',
    );
    try {
      await runPipeline(payload.jobId);
      logger.info(
        { jobId: payload.jobId, runId: ctx.run.id },
        'trigger.dev task completed: process-video-job',
      );
      return { ok: true, jobId: payload.jobId };
    } catch (err) {
      // SDK v4 task 失败 = trigger.dev dashboard 标 failed run
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { jobId: payload.jobId, runId: ctx.run.id, err: message },
        'trigger.dev task FAILED: process-video-job',
      );
      throw err;
    }
  },
});
