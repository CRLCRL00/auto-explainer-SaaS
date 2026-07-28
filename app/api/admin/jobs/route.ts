import { NextResponse } from 'next/server';
import { desc, eq, and } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { jobs } from '@/lib/schema';
import { getEnv } from '@/lib/env';
import { createBasicAuthMiddleware, unauthorizedResponse } from '@/lib/auth';

/**
 * v0.6.1 R6: GET /api/admin/jobs — list + filter jobs for dashboard.
 *
 * Query params:
 *   - status: 'pending' | 'running' | 'done' | 'failed'
 *   - humanInLoop: '1' to filter jobs with non-null human_in_loop_reason
 *   - limit: 1..200 default 50
 *
 * Auth: same BASIC_AUTH_USER/PASS as /api/jobs (share env). nginx basic auth
 * 在 prod 反代时也守 — 这里 dev mode 跳过 (与 POST /api/jobs 走同样逻辑).
 */

export async function GET(req: Request) {
  if (process.env.NODE_ENV === 'production') {
    const env = getEnv();
    const authed = createBasicAuthMiddleware({ user: env.BASIC_AUTH_USER, pass: env.BASIC_AUTH_PASS })(req);
    if (!authed) return unauthorizedResponse();
  }

  const url = new URL(req.url);
  const status = url.searchParams.get('status') ?? null;
  const humanInLoop = url.searchParams.get('humanInLoop') === '1';
  const rawLimit = Number(url.searchParams.get('limit') ?? '50');
  const limit = Math.max(1, Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 50));

  const db = getDb();
  const conditions = [];
  if (status && ['pending', 'running', 'done', 'failed', 'dead'].includes(status)) {
    conditions.push(eq(jobs.status, status as 'pending'));
  }
  if (humanInLoop) {
    // Filter to jobs with non-null humanInLoopReason — wall-hit jobs needing attention.
    // Drizzle's `isNotNull` would be cleaner but using truthiness check via ne(null) for compat.
    conditions.push(eq(jobs.humanInLoopReason, '__set__')); // placeholder see below
    // Better: use ne condition
    conditions.pop();
    const { ne, isNotNull } = await import('drizzle-orm');
    conditions.push(isNotNull(jobs.humanInLoopReason));
    void ne;
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: jobs.id,
      status: jobs.status,
      phase: jobs.phase,
      attempts: jobs.attempts,
      inputType: jobs.inputType,
      inputPayload: jobs.inputPayload,
      humanInLoopReason: jobs.humanInLoopReason,
      lastError: jobs.lastError,
      startedAt: jobs.startedAt,
      finishedAt: jobs.finishedAt,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .where(where)
    .orderBy(desc(jobs.createdAt))
    .limit(limit);

  // Truncate input_payload to avoid huge responses
  const truncated = rows.map((r) => ({
    ...r,
    inputPayload: { topic: String((r.inputPayload as { topic?: unknown })?.topic ?? '').slice(0, 80) },
  }));

  return NextResponse.json({ jobs: truncated, count: truncated.length });
}
