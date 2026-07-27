import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { jobs, phaseEnum } from '@/lib/schema';
import { recordEvent } from '@/lib/job-events';
import { logger } from '@/lib/logger';
import { phaseOutline } from './phases/outline';
import { phaseScript } from './phases/script';
import { phaseQgPlan } from './phases/qg-plan';
import { phaseHtml } from './phases/html';
import { phaseProbe } from './phases/probe';
import { phaseRecord } from './phases/record';
import { phaseEncode } from './phases/encode';
import { phaseEncodeCreatomate } from './phases/encode-creatomate';

type PhaseName = (typeof phaseEnum.enumValues)[number];

interface PipelineStep {
  name: PhaseName;
  run: (jobId: string) => Promise<void>;
}

// P0 POC: RUN_CREATOMATE_POC=1 时把最后的 encode phase 切到 Creatomate SaaS 路径，
// 旧 FFmpeg 路径保留作回退 (默认)。详见 docs/refactor-plan-v0.1.md §7.2。
const USE_CREATOMATE_POC = process.env.RUN_CREATOMATE_POC === '1';

// v0.0.1 简化：所有阶段顺序跑，单 attempt，失败直接 failed。
// v0.5 起加 retry + 撞墙拐点（spec §4）。
// Task 15：插入 ScriptWriter phase (script_ready) 在 planning_qg 后、html_ready 前。
const PHASE_ORDER: PipelineStep[] = [
  { name: 'planning_done',  run: phaseOutline },     // 完成 planning，等价于 planning_done
  { name: 'planning_qg',    run: phaseQgPlan },      // 5-beat / duration 上限 / 必填字段 (spec §4.2)
  { name: 'script_ready',   run: phaseScript },      // ScriptWriter: per-beat narration/caption/tts_text (Task 15)
  { name: 'html_ready',     run: phaseHtml },        // render + selector
  { name: 'probing',        run: phaseProbe },
  { name: 'recording_done', run: phaseRecord },
  { name: 'done',           run: USE_CREATOMATE_POC ? phaseEncodeCreatomate : phaseEncode },
];

export async function runPipeline(jobId: string) {
  const db = getDb();

  await db.update(jobs).set({ startedAt: new Date(), status: 'running' })
    .where(eq(jobs.id, jobId));

  try {
    for (const step of PHASE_ORDER) {
      logger.info({ jobId, phase: step.name }, 'phase starting');
      await db.update(jobs).set({ phase: step.name, status: 'running', attempts: 1 })
        .where(eq(jobs.id, jobId));

      await step.run(jobId);
      await recordEvent(jobId, step.name, 'phase_completed');
    }

    await db.update(jobs).set({ status: 'done', finishedAt: new Date() })
      .where(eq(jobs.id, jobId));
  } catch (err) {
    // defend against non-Error throwables (string / number / undefined)
    const message = errToMessage(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.error({ jobId, err: message, stack }, 'pipeline failed');
    await db.update(jobs).set({
      status: 'failed',
      finishedAt: new Date(),
      lastError: { message, stack },
    }).where(eq(jobs.id, jobId));
    throw err;
  }
}

function errToMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}