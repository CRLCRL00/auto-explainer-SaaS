import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { jobs } from '@/lib/schema';
import { createBasicAuthMiddleware, unauthorizedResponse } from '@/lib/auth';
import { getJobQueue, JOB_QUEUE_NAME } from '@/lib/queue';
import { recordEvent } from '@/lib/job-events';
import { getEnv } from '@/lib/env';

const InputSchema = z.object({
  inputType: z.enum(['text']),  // v0.0.1 only text
  topic: z.string().min(1).max(500),
});

// auth middleware built per-request (env can change in tests)
function authMw() {
  const env = getEnv();
  return createBasicAuthMiddleware({ user: env.BASIC_AUTH_USER, pass: env.BASIC_AUTH_PASS });
}

export async function POST(req: Request) {
  const user = authMw()(req);
  if (!user) return unauthorizedResponse();

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const parsed = InputSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_input', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const db = getDb();
  const [job] = await db.insert(jobs).values({
    userId: user,
    status: 'pending',
    phase: 'pending',
    inputType: parsed.data.inputType,
    inputPayload: { topic: parsed.data.topic },
  }).returning();

  // 入队
  await getJobQueue().add(JOB_QUEUE_NAME, { jobId: job.id, phase: 'pending' });
  await recordEvent(job.id, 'pending', 'created', parsed.data);

  return NextResponse.json({ jobId: job.id }, { status: 201 });
}