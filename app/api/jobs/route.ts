import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { jobs, triggerRuns } from '@/lib/schema';
import { createBasicAuthMiddleware, unauthorizedResponse } from '@/lib/auth';
import { getJobQueue, JOB_QUEUE_NAME } from '@/lib/queue';
import { recordEvent } from '@/lib/job-events';
import { getEnv } from '@/lib/env';
import { triggerJob } from '@/lib/trigger';
import { logger } from '@/lib/logger';

const InputSchema = z.object({
  inputType: z.literal('text'),  // v0.0.1 only text
  topic: z.string().min(1).max(500),
});

// 10KB 上限：topic 限 500 字，JSON 包装远小于此。防止恶意大 body OOM。
const MAX_BODY_BYTES = 10 * 1024;

function authMw() {
  const env = getEnv();
  return createBasicAuthMiddleware({ user: env.BASIC_AUTH_USER, pass: env.BASIC_AUTH_PASS });
}

export async function POST(req: Request) {
  const user = authMw()(req);
  if (!user) return unauthorizedResponse();

  // 早返回大 body（避免 req.json() 一次性读入内存）
  const lenHeader = req.headers.get('content-length');
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = InputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_input', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // 顶层 try/catch 兜底：DB / Queue / 任意抛错统一 JSON 500，避免 Next.js 默认 HTML stack trace 外泄
  try {
    const db = getDb();
    const env = getEnv();
    const [job] = await db.insert(jobs).values({
      userId: user,
      status: 'pending',
      phase: 'pending',
      inputType: parsed.data.inputType,
      inputPayload: { topic: parsed.data.topic },
    }).returning();

    // P1 PR2: dual-run enqueue path.
    //   - RUN_TRIGGER_DEV=0 (default) → 走 BullMQ 原路径, 行为不变.
    //   - RUN_TRIGGER_DEV=1 + jobId 尾字符 hex 偶数 → 走 Trigger.dev, 失败 fallback BullMQ.
    //   - jobId 尾字符奇数 → 无论 flag 走 BullMQ.
    // 50/50 切流目的是让 PR2 阶段产出可观测 Trigger.dev 流量, 又保留 BullMQ
    // 作主路径避免 SDK 不可用时整个 enqueue 链断.
    const tailCharCode = job.id.charCodeAt(job.id.length - 1);
    const shouldUseTrigger = env.RUN_TRIGGER_DEV === '1' && tailCharCode % 2 === 0;

    if (shouldUseTrigger) {
      try {
        const { runId } = await triggerJob({ jobId: job.id });
        // PR3 worker 端通过 trigger_runs.status / started_at / finished_at 更新状态;
        // 这里 PR2 仅初始 audit row.
        try {
          await db.insert(triggerRuns).values({
            jobId: job.id,
            runId,
            status: 'pending',
          });
        } catch (insertErr) {
          // 表未 migrate 不阻断主流程 (部署前需 `npm run db:migrate`)
          logger.warn(
            { jobId: job.id, runId, err: (insertErr as Error).message },
            'trigger_runs insert skipped (table missing — run npm run db:migrate)',
          );
        }
        await recordEvent(job.id, 'pending', 'enqueued_trigger', { runId });
      } catch (triggerErr) {
        logger.warn(
          { jobId: job.id, err: (triggerErr as Error).message },
          'triggerJob failed; falling back to BullMQ',
        );
        await getJobQueue().add(JOB_QUEUE_NAME, { jobId: job.id, phase: 'pending' });
        await recordEvent(job.id, 'pending', 'fallback_bullmq', { reason: 'trigger_failed' });
      }
    } else {
      await getJobQueue().add(JOB_QUEUE_NAME, { jobId: job.id, phase: 'pending' });
    }

    // payload 是事件元数据，不重复 input 数据（已在 jobs.inputPayload）
    await recordEvent(job.id, 'pending', 'created', { source: 'api', format: 'text' });

    return NextResponse.json({ jobId: job.id }, { status: 201 });
  } catch (err) {
    logger.error({ err: (err as Error).message, user, inputType: parsed.data.inputType }, 'POST /api/jobs failed');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
