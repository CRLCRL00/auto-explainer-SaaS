import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import fs from 'fs/promises';
import path from 'path';
import { getDb } from '@/lib/db';
import { jobs } from '@/lib/schema';
import { createBasicAuthMiddleware, unauthorizedResponse } from '@/lib/auth';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';

const authMw = () => {
  const env = getEnv();
  return createBasicAuthMiddleware({ user: env.BASIC_AUTH_USER, pass: env.BASIC_AUTH_PASS });
};

export async function GET(
  req: Request,
  { params }: { params: { id: string; kind: string } },
) {
  if (!authMw()(req)) return unauthorizedResponse();
  if (params.kind !== 'mp4') return new Response('not supported in v0.0.1', { status: 400 });

  const db = getDb();
  const [job] = await db.select().from(jobs).where(eq(jobs.id, params.id)).limit(1);
  if (!job || job.status !== 'done') return new Response('not ready', { status: 404 });

  const filePath = path.join(process.cwd(), 'storage', 'jobs', params.id, 'video.mp4');
  try {
    const data = await fs.readFile(filePath);
    return new Response(data, {
      headers: {
        'content-type': 'video/mp4',
        'content-disposition': `attachment; filename="video-${params.id.slice(0, 8)}.mp4"`,
      },
    });
  } catch {
    return new Response('file missing', { status: 404 });
  }
}