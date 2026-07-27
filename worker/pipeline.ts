import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { jobs, phaseEnum } from '@/lib/schema';
import { recordEvent } from '@/lib/job-events';
import { logger } from '@/lib/logger';
import {
  runPhaseWithRetry,
  assertPipelineBudget,
  RetryWallHitError,
} from '@/lib/pipeline/retry';
import { checkRender as qgRender, checkFinal as qgFinal } from '@/lib/pipeline/qg-checks';
import { phaseOutline } from './phases/outline';
import { phaseScript } from './phases/script';
import { phaseQgPlan } from './phases/qg-plan';
import { phaseHtml } from './phases/html';
import { phaseProbe } from './phases/probe';
import { phaseRecord } from './phases/record';
import { phaseEncodeCreatomate } from './phases/encode-creatomate';
import { loadFramesMeta, computeRealFps } from './phases/fps';

type PhaseName = (typeof phaseEnum.enumValues)[number];

interface PipelineStep {
  name: PhaseName;
  run: (jobId: string) => Promise<void>;
}

// P0 全量: 唯一 render path 是 Creatomate (POC flag RUN_CREATOMATE_POC 已删除, hard cut).
// 旧 FFmpeg 路径退役 — phaseEncode 现只是 thin wrapper 透传 phaseEncodeCreatomate.
// 详见 docs/refactor-plan-v0.1.md §7.3.

// v0.5: 每 phase 用 runPhaseWithRetry 包 — maxAttempts=2 (1 原始 + 1 重试),
// 撞墙扔 RetryWallHitError. 若 phase 自带 [non-retryable] error hint 立即撞墙.
//   - probe/record/encode: 还跑 QG-render / QG-final 第二关检查.
//   - 整 pipeline 用 assertPipelineBudget 兜底 wall-clock 默认 5 分钟.
const PIPELINE_BUDGET_MS = 5 * 60 * 1000;

const PHASE_ORDER: PipelineStep[] = [
  { name: 'planning_done', run: phaseOutline },
  { name: 'planning_qg', run: phaseQgPlan },
  { name: 'script_ready', run: phaseScript },
  { name: 'html_ready', run: phaseHtml },
  { name: 'probing', run: phaseProbe },
  { name: 'recording_done', run: phaseRecord },
  { name: 'creatomate_rendering', run: phaseEncodeCreatomate },
];

/** QG-render 检查: phaseRecord 完成后的渲染产物合理性 (realFps/chrome/frameCount). */
async function qgRenderAfterRecord(jobId: string): Promise<void> {
  const jobDir = require('node:path').join(process.cwd(), 'storage', 'jobs', jobId);
  const framesDir = require('node:path').join(jobDir, 'frames');
  const frames = await loadFramesMeta(framesDir);
  const realFps = computeRealFps(frames);
  await qgRender({ realFps, frameCount: frames.length, browserCrashed: false });
}

/** QG-final 检查: phaseEncode 完成后的 mp4 文件 sanity. */
async function qgFinalAfterEncode(jobId: string): Promise<void> {
  const jobDir = require('node:path').join(process.cwd(), 'storage', 'jobs', jobId);
  const mp4Path = require('node:path').join(jobDir, 'video.mp4');
  await qgFinal({ mp4Path });
}

export async function runPipeline(jobId: string): Promise<void> {
  await assertPipelineBudget(jobId, PIPELINE_BUDGET_MS, async () => {
    const db = getDb();

    await db.update(jobs).set({ startedAt: new Date(), status: 'running' })
      .where(eq(jobs.id, jobId));

    try {
      for (const step of PHASE_ORDER) {
        logger.info({ jobId, phase: step.name }, 'phase starting');
        await db.update(jobs).set({ phase: step.name, status: 'running', attempts: 1 })
          .where(eq(jobs.id, jobId));

        // v0.5 retry + QG 检查分层:
        //   1. phase main run (with per-attempt timeout 90s + retries)
        //   2. phase-specific QG (record 后 → QG-render, encode 后 → QG-final)
        await runPhaseWithRetry(async (attempt) => {
          await step.run(jobId);
          // QG check 在 retry helper 内 — 失败会触发下一 attempt
          if (step.name === 'recording_done') {
            await qgRenderAfterRecord(jobId);
          } else if (step.name === 'creatomate_rendering') {
            await qgFinalAfterEncode(jobId);
          }
        }, {
          phaseName: step.name,
          maxAttempts: 2,
          retryDelayMs: 1500,
          attemptTimeoutMs: 90_000,
        });

        await recordEvent(jobId, step.name, 'phase_completed', {
          attempt: 1, // QG-render / QG-final 都过了
        });
      }

      await db.update(jobs).set({ status: 'done', finishedAt: new Date() })
        .where(eq(jobs.id, jobId));
    } catch (err) {
      // defend against non-Error throwables (string / number / undefined)
      const message = errToMessage(err);
      const stack = err instanceof Error ? err.stack : undefined;
      const isWallHit = err instanceof RetryWallHitError;
      logger.error(
        { jobId, err: message, stack, isWallHit, phaseName: isWallHit ? err.phaseName : undefined },
        'pipeline failed (or 撞墙)',
      );
      await db.update(jobs).set({
        status: 'failed',
        finishedAt: new Date(),
        lastError: { message, stack, isWallHit: isWallHit ? true : undefined },
      }).where(eq(jobs.id, jobId));
      throw err;
    }
  });
}

function errToMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}
