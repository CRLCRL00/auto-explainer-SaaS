import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { jobs, triggerRuns } from '@/lib/schema';
import { getEnv } from '@/lib/env';
import { createBasicAuthMiddleware, unauthorizedResponse } from '@/lib/auth';
import { triggerJob, inlineDevEnqueue } from '@/lib/trigger';
import { recordEvent } from '@/lib/job-events';
import { logger } from '@/lib/logger';

/**
 * v0.7: POST /api/admin/jobs/[id]/retry — re-enqueue a failed or wall-hit job.
 *
 * Behavior:
 *   1. Look up job by id
 *   2. Verify status is retryable (status='failed' | 'dead' OR humanInLoopReason IS NOT NULL)
 *   3. Reset job state:
 *      - status = 'pending'
 *      - phase = 'planning_done' (restart from beginning)
 *      - attempts += 1 (audit trail)
 *      - finishedAt = null
 *      - lastError = null
 *      - humanInLoopReason = null
 *      - startedAt = null
 *   4. Re-enqueue trigger-web task (or inline dev enqueue in dev mode)
 *   5. Insert trigger_runs row
 *   6. Return new {retried: true, runId, attempts}
 *
 * Auth: same as admin GET — basic auth in production (dev skip).
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  // Auth (prod: nginx basic auth also covers; this is belt-and-suspenders)
  if (process.env.NODE_ENV === 'production') {
    const env = getEnv();
    const authed = createBasicAuthMiddleware({ user: env.BASIC_AUTH_USER, pass: env.BASIC_AUTH_PASS })(req);
    if (!authed) return unauthorizedResponse();
  }

  const db = getDb();
  const [job] = await db.select().from(jobs).where(eq(jobs.id, params.id)).limit(1);
  if (!job) {
    return NextResponse.json({ retried: false, error: 'not_found' }, { status: 404 });
  }

  // Retryable check — failed OR dead OR wall-hit
  const isTerminal = job.status === 'failed' || job.status === 'dead';
  const isWallHit = job.humanInLoopReason !== null;
  if (!isTerminal && !isWallHit) {
    return NextResponse.json(
      {
        retried: false,
        error: 'not_retryable',
        detail: `status=${job.status} (only failed/dead/wall-hit jobs are retryable)`,
      },
      { status: 409 },
    );
  }

  // Re-enqueue (sync dispatch — same pattern as POST /api/jobs)
  // v0.7.1: also honor RUN_TRIGGER_DEV. Same pattern as POST /api/jobs.
  // prod-without-real-Trigger.dev (RUN_TRIGGER_DEV=1) → inlineDevEnqueue.
  const { runId } =
    process.env.NODE_ENV === 'production' && process.env.RUN_TRIGGER_DEV !== '1'
      ? await triggerJob({ jobId: job.id })
      : await inlineDevEnqueue({ jobId: job.id });

  const newAttempts = (job.attempts ?? 0) + 1;
  await db
    .update(jobs)
    .set({
      status: 'pending',
      phase: 'planning_done',
      attempts: newAttempts,
      finishedAt: null,
      startedAt: null,
      lastError: null,
      humanInLoopReason: null,
    })
    .where(eq(jobs.id, job.id));

  // trigger_runs audit row
  try {
    await db.insert(triggerRuns).values({
      jobId: job.id,
      runId,
      status: 'pending',
    });
  } catch (err) {
    logger.warn(
      { jobId: job.id, err: err instanceof Error ? err.message : String(err) },
      'trigger_runs insert skipped (admin retry)',
    );
  }

  await recordEvent(job.id, 'planning_done', 'admin_retry', {
    runId,
    attempts: newAttempts,
    previousStatus: job.status,
    previousWallReason: job.humanInLoopReason,
  });

  logger.info({ jobId: job.id, runId, attempts: newAttempts }, 'admin: job retried');

  return NextResponse.json({
    retried: true,
    runId,
    attempts: newAttempts,
  });
}
