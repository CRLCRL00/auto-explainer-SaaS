import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { jobs, phaseEnum } from '@/lib/schema';
import { recordEvent } from '@/lib/job-events';
import { logger } from '@/lib/logger';
import { phaseOutline } from './phases/outline';
import { phaseScript } from './phases/script';
import { phaseHtml } from './phases/html';
import { phaseProbe } from './phases/probe';
import { phaseRecord } from './phases/record';
import { phaseEncode } from './phases/encode';

type PhaseName = (typeof phaseEnum.enumValues)[number];

interface PipelineStep {
  name: PhaseName;
  run: (jobId: string) => Promise<void>;
}

// v0.0.1 简化：所有阶段顺序跑，单 attempt，失败直接 failed。
// v0.5 起加 retry + 撞墙拐点（spec §4）。
// 注意：phaseScript 已 import 但未插入 PHASE_ORDER —— 留给 v0.5 在 outline 后插入。
const PHASE_ORDER: PipelineStep[] = [
  { name: 'planning_done',  run: phaseOutline },     // 完成 planning，等价于 planning_done
  { name: 'html_ready',     run: phaseHtml },       // render + selector
  { name: 'probing',        run: phaseProbe },
  { name: 'recording_done', run: phaseRecord },
  { name: 'done',           run: phaseEncode },
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