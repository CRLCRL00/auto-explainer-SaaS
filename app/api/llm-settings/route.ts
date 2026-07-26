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

// 10KB 上限：provider + model + baseURL + apiKey 都远小于此；防止恶意大 body OOM。
const MAX_BODY_BYTES = 10 * 1024;

const InputSchema = z.object({
  provider: z.enum(['anthropic', 'openai-compatible']).optional(),
  // model 和 apiKey 都 optional — 但至少要传一个能区分"换了什么"。
  // 实际 merge 语义：
  //   - 传了 model → 覆盖旧 model（可以保留旧 apiKey）
  //   - 传了 apiKey → 覆盖旧 apiKey（可以保留旧 model）
  //   - 两个都不传 → 400 (no-op)
  model: z.string().min(1).max(80).optional(),
  baseURL: z.string().max(500).optional(),
  apiKey: z.string().min(10).max(200).optional(),
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

  // 没传 model 也没传 apiKey → no-op，明确拒绝避免 silent
  if (parsed.data.model === undefined && parsed.data.apiKey === undefined) {
    return NextResponse.json(
      { error: 'empty_update', message: 'must provide at least model or apiKey' },
      { status: 400 },
    );
  }

  try {
    // merge 模式：未传字段保留旧值，让 UI 能"切 provider/model 不重传 key"
    await writeLlmSettings(
      {
        provider: parsed.data.provider,
        model: parsed.data.model,
        baseURL: parsed.data.baseURL,
        apiKey: parsed.data.apiKey,
      },
      undefined,
      { merge: true },
    );
    // 回读最新状态用于响应 (apiKey 仍 redact)
    const updated = await readLlmSettings();
    const redacted = redactSettings(updated);
    return NextResponse.json(
      {
        ok: true,
        provider: redacted.provider,
        model: redacted.model,
        configured: redacted.configured,
      },
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
