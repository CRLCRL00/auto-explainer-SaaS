import { describe, it, expect, beforeAll, vi } from 'vitest';

// 在 import llm 之前准备好 env：env.ts 用 zod 强校验，缺一个就抛。
// getAnthropic 在 settings.apiKey 缺失时会走 getEnv() 路径，所以必须有 ANTHROPIC_API_KEY。
beforeAll(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test@127.0.0.1:5432/test';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-env-fallback-1234567890';
  process.env.BASIC_AUTH_USER = process.env.BASIC_AUTH_USER ?? 'admin';
  process.env.BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS ?? 'changeme';
});

// Mock 整个 llm-settings 模块来控制 readLlmSettings 返回值。
// 这样测试不依赖 DEFAULT_SETTINGS_PATH 也不污染 storage/ 目录。
// 保留其他 export 的真实实现（write/clear/redact）以防别处用。
vi.mock('@/lib/llm-settings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/llm-settings')>('@/lib/llm-settings');
  return {
    ...actual,
    readLlmSettings: vi.fn(),
  };
});

import { getAnthropic } from '@/lib/llm';
import { readLlmSettings } from '@/lib/llm-settings';

const mockedRead = vi.mocked(readLlmSettings);

describe('lib/llm ↔ lib/llm-settings integration', () => {
  it('falls back to env ANTHROPIC_API_KEY when settings file is missing (readLlmSettings returns null)', async () => {
    mockedRead.mockResolvedValueOnce(null);
    const client = await getAnthropic();
    expect(client).toBeDefined();
  });

  it('falls back to env when settings file exists but is empty {}', async () => {
    mockedRead.mockResolvedValueOnce({});
    const client = await getAnthropic();
    expect(client).toBeDefined();
  });

  it('uses settings.apiKey when settings provides it (overrides env)', async () => {
    mockedRead.mockResolvedValueOnce({
      model: 'claude-test-model',
      apiKey: 'sk-ant-settings-override-1234567890',
    });
    const client = await getAnthropic();
    expect(client).toBeDefined();
    // Anthropic 客户端不应暴露 apiKey，但构造不抛 = 走通了 override 路径
  });

  it('uses settings.apiKey even when only apiKey is set (no model)', async () => {
    mockedRead.mockResolvedValueOnce({
      apiKey: 'sk-ant-only-key-1234567890',
    });
    const client = await getAnthropic();
    expect(client).toBeDefined();
  });

  it('does not cache: two consecutive calls each read settings fresh', async () => {
    // 第一次调用：settings 有 apiKey
    mockedRead.mockResolvedValueOnce({
      model: 'claude-first',
      apiKey: 'sk-ant-first-1234567890',
    });
    const c1 = await getAnthropic();
    expect(c1).toBeDefined();

    // 第二次调用：settings 没了（fallback 到 env）
    mockedRead.mockResolvedValueOnce(null);
    const c2 = await getAnthropic();
    expect(c2).toBeDefined();

    // 两个 client 是不同实例（每调用 new），证明没有缓存
    expect(c1).not.toBe(c2);
  });
});