import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { jobs } from '@/lib/schema';
import { createBasicAuthMiddleware, unauthorizedResponse } from '@/lib/auth';
import { getEnv } from '@/lib/env';

const authMw = () => {
  const env = getEnv();
  return createBasicAuthMiddleware({ user: env.BASIC_AUTH_USER, pass: env.BASIC_AUTH_PASS });
};

export async function GET(
  req: Request,
  { params }: { params: { id: string } },
) {
  if (!authMw()(req)) return unauthorizedResponse();

  const db = getDb();
  const [job] = await db.select().from(jobs).where(eq(jobs.id, params.id)).limit(1);
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return NextResponse.json({
    id: job.id,
    status: job.status,
    phase: job.phase,
    attempts: job.attempts,
    inputType: job.inputType,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastError: job.lastError,
  });
}
