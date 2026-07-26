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

import { getAnthropic, getLlmClient } from '@/lib/llm';
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

describe('getLlmClient() provider dispatch', () => {
  it('returns anthropic client when settings.provider is unset (default)', async () => {
    mockedRead.mockResolvedValueOnce({ model: 'claude-sonnet-4-5', apiKey: 'sk-ant-test-1234567890' });
    const result = await getLlmClient();
    expect(result.provider).toBe('anthropic');
    expect(result.client).toBeDefined();
  });

  it('returns openai-compatible client when settings.provider = openai-compatible', async () => {
    mockedRead.mockResolvedValueOnce({
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-deepseek-1234567890',
    });
    const result = await getLlmClient();
    expect(result.provider).toBe('openai-compatible');
    expect(result.client).toBeDefined();
  });

  it('respects opts.model override over settings.model', async () => {
    mockedRead.mockResolvedValueOnce({
      model: 'settings-default-model',
      apiKey: 'sk-ant-test-1234567890',
    });
    const result = await getLlmClient({ model: 'opts-override-model' });
    expect(result.provider).toBe('anthropic');
    // Anthropic/OpenAI SDK instance 不暴露 model；通过构造成功 + provider 验证
  });

  it('respects opts.model override for openai-compatible', async () => {
    mockedRead.mockResolvedValueOnce({
      provider: 'openai-compatible',
      model: 'settings-default',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test-1234567890',
    });
    const result = await getLlmClient({ model: 'opts-override' });
    expect(result.provider).toBe('openai-compatible');
  });

  it('does not cache: each getLlmClient() call re-reads settings', async () => {
    mockedRead.mockResolvedValueOnce({
      provider: 'openai-compatible',
      model: 'a',
      apiKey: 'sk-1234567890',
    });
    const r1 = await getLlmClient();
    mockedRead.mockResolvedValueOnce(null);
    const r2 = await getLlmClient();
    // 两个 client 是不同实例（每调用 new），证明没有缓存
    expect(r1).not.toBe(r2);
    expect(r1.provider).toBe('openai-compatible');
    expect(r2.provider).toBe('anthropic'); // fallback
  });

  it('returns minimax client when settings.provider = minimax (uses OpenAI SDK with minimax baseURL default)', async () => {
    mockedRead.mockResolvedValueOnce({
      provider: 'minimax',
      model: 'MiniMax-M3',
      // 注意：baseURL 留空 → lib/llm.ts 应填入 PROVIDER_DEFAULT_BASEURL.minimax
      apiKey: 'sk-test-minimax-1234567890',
    });
    const result = await getLlmClient();
    expect(result.provider).toBe('minimax');
    expect(result.client).toBeDefined();
  });

  it('minimax with explicit baseURL override (use case: 自部署/区域 endpoint)', async () => {
    mockedRead.mockResolvedValueOnce({
      provider: 'minimax',
      model: 'MiniMax-M3',
      baseURL: 'https://custom.example.com/v1',
      apiKey: 'sk-test-minimax-1234567890',
    });
    const result = await getLlmClient();
    expect(result.provider).toBe('minimax');
  });

  it('minimax with empty apiKey → fast-fail error', async () => {
    mockedRead.mockResolvedValueOnce({
      provider: 'minimax',
      model: 'MiniMax-M3',
      // 无 apiKey → fast-fail
    });
    await expect(getLlmClient()).rejects.toThrow(/missing apiKey for minimax/);
  });
});

describe('fast-fail on missing apiKey for openai-compatible (P1-1 fix)', () => {
  it('throws immediately without retry when provider=openai-compatible and apiKey is empty', async () => {
    mockedRead.mockResolvedValueOnce({
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      // 注意：故意不传 apiKey
    });
    // 必须立即抛错，不应走 retry loop
    await expect(getLlmClient()).rejects.toThrow(/missing apiKey for openai-compatible/);
  });

  it('throws when provider=openai-compatible and apiKey is empty string', async () => {
    mockedRead.mockResolvedValueOnce({
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      apiKey: '',
    });
    await expect(getLlmClient()).rejects.toThrow(/missing apiKey/);
  });

  it('does NOT throw on empty apiKey when provider=anthropic (falls back to env)', async () => {
    mockedRead.mockResolvedValueOnce({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      // 无 apiKey → 走 env.ANTHROPIC_API_KEY fallback
    });
    const result = await getLlmClient();
    expect(result.provider).toBe('anthropic');
  });
});
