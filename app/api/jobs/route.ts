import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { jobs, triggerRuns } from '@/lib/schema';
import { createBasicAuthMiddleware, unauthorizedResponse } from '@/lib/auth';
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

  // 顶层 try/catch 兜底：DB / Trigger.dev / 任意抛错统一 JSON 500
  try {
    const db = getDb();
    const [job] = await db.insert(jobs).values({
      userId: user,
      status: 'pending',
      phase: 'pending',
      inputType: parsed.data.inputType,
      inputPayload: { topic: parsed.data.topic },
    }).returning();

    // P1 PR4: enqueue path is 100% Trigger.dev (no more BullMQ fallback).
    // RUN_TRIGGER_DEV=0 path was removed; if the flag is unset, the schema
    // validator will default it to '1' (PR3 change) — i.e. trigger always.
    const { runId } = await triggerJob({ jobId: job.id });

    // Audit row — trigger_runs.status / startedAt / finishedAt are populated
    // later by the Trigger.dev worker runtime via runs.retrieve polling.
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
    // payload 是事件元数据，不重复 input 数据（已在 jobs.inputPayload）
    await recordEvent(job.id, 'pending', 'created', { source: 'api', format: 'text' });

    return NextResponse.json({ jobId: job.id }, { status: 201 });
  } catch (err) {
    logger.error({ err: (err as Error).message, user, inputType: parsed.data.inputType }, 'POST /api/jobs failed');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
