import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createBasicAuthMiddleware, unauthorizedResponse } from '@/lib/auth';
import { getEnv } from '@/lib/env';
import {
  clearLlmSettings,
  readLlmSettings,
  redactSettings,
  writeLlmSettings,
} from '@/lib/llm-settings';

// 强制 auth（与 jobs 路由一致的 Basic Auth 模式）
function authMw() {
  const env = getEnv();
  return createBasicAuthMiddleware({ user: env.BASIC_AUTH_USER, pass: env.BASIC_AUTH_PASS });
}

// 10KB 上限：model + apiKey 都远小于此；防止恶意大 body OOM。
const MAX_BODY_BYTES = 10 * 1024;

const InputSchema = z.object({
  model: z.string().min(1).max(80),
  apiKey: z.string().min(10).max(200),
});

export async function GET(req: Request) {
  const user = authMw()(req);
  if (!user) return unauthorizedResponse();

  try {
    const settings = await readLlmSettings();
    return NextResponse.json(redactSettings(settings), { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: 'internal_error', detail: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const user = authMw()(req);
  if (!user) return unauthorizedResponse();

  // 早返回大 body
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

  try {
    await writeLlmSettings({ model: parsed.data.model, apiKey: parsed.data.apiKey });
    return NextResponse.json(
      { ok: true, model: parsed.data.model, configured: true },
      { status: 200 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: 'internal_error', detail: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request) {
  const user = authMw()(req);
  if (!user) return unauthorizedResponse();

  try {
    await clearLlmSettings();
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: 'internal_error', detail: (err as Error).message },
      { status: 500 },
    );
  }
}
