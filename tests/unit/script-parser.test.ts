import { describe, it, expect, beforeAll } from 'vitest';

// worker/phases/html.ts transitively imports lib/db.ts → lib/logger.ts →
// calls getEnv() at module top. Tests must seed env vars before dynamic import.
beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://postgres@127.0.0.1:5432/aesaas';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-placeholder-key';
  process.env.BASIC_AUTH_USER ??= 'admin';
  process.env.BASIC_AUTH_PASS ??= 'changeme';
});

let parseScriptMd: typeof import('@/worker/phases/html').parseScriptMd;
beforeAll(async () => {
  ({ parseScriptMd } = await import('@/worker/phases/html'));
});

describe('parseScriptMd', () => {
  it('parses 5-beat script', () => {
    const md = `
## b1 · 钩子

你以为 RAG 是魔法？错。

## b2 · 定义

RAG = 检索增强生成。`.trim();
    const map = parseScriptMd(md);
    expect(map.get('b1')).toBe('你以为 RAG 是魔法？错。');
    expect(map.get('b2')).toBe('RAG = 检索增强生成。');
  });
});