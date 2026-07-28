// v0.6.1 integration: callLlm 的 anthropic path 现在 wire 进
// withAnthropicFallback (lib/llm-fallback.ts). 这 test 覆盖 callLlm 端到端
// 集成 (不再 direct unit-test wrapper 本身 — 那在 tests/unit/llm-fallback.test.ts).
//
// 覆盖 4 路径:
//   1. anthropic 成功 → OpenAI client 不构造 (mock 不被调)
//   2. anthropic 5xx + OPENAI_API_KEY 配齐 → fallback 走通, OpenAI chat
//      completion 返结果
//   3. anthropic 5xx + OPENAI_API_KEY 未配 (空字符串) → wrapper log warn +
//      re-throw 原 anthropic err
//   4. anthropic 4xx logic 错 → 不触发 fallback, throw 400
//
// vitest hoisting: vi.mock factories run before module-level consts —
// use vi.hoisted() 暴露变量. lib/logger.ts module-level `getEnv()` 在
// import 时立刻跑 — mock factory 必须默认有 env return, 否则 logger
// 拿 undefined.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

beforeAll(() => {
  // env.ts Zod 强校验必填 — 设 stub 让 resolveConfig 跑通.
  process.env.DATABASE_URL ??= 'postgres://test@127.0.0.1:5432/test';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-env-fallback-1234567890';
  process.env.BASIC_AUTH_USER ??= 'admin';
  process.env.BASIC_AUTH_PASS ??= 'changeme';
  process.env.CREATOMATE_API_KEY ??= 'creato-test-key-1234567890';
});

// vi.hoisted: 在 vi.mock factory 之前 hoist, 因此 factory 内可引用.
const hoisted = vi.hoisted(() => ({
  DEFAULT_TEST_ENV: {
    DATABASE_URL: 'postgres://test@127.0.0.1:5432/test',
    REDIS_URL: 'redis://127.0.0.1:6379',
    ANTHROPIC_API_KEY: 'sk-ant-env-fallback-1234567890',
    CREATOMATE_API_KEY: 'creato-test-key-1234567890',
    CREATOMATE_TEMPLATE_ID: 'creatomate-builtin-30s-5beats',
    CREATOMATE_POLL_MS: 3000,
    CREATOMATE_POLL_TIMEOUT_MS: 600000,
    BASIC_AUTH_USER: 'admin',
    BASIC_AUTH_PASS: 'changeme',
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    TRIGGER_DEPLOYMENT: 'self-hosted',
    RUN_TRIGGER_DEV: '0',
    OPENAI_API_KEY: '',
  },
  mockAnthropicCreate: vi.fn(),
  mockOpenAICreate: vi.fn(),
}));

const { DEFAULT_TEST_ENV, mockAnthropicCreate, mockOpenAICreate } = hoisted;

// SDK mocks — module-level, 在 import callLlm 之前 hoist.
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: hoisted.mockAnthropicCreate },
  })),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: hoisted.mockOpenAICreate,
      },
    },
  })),
}));

// readLlmSettings mock — 控制 provider dispatch 入口.
vi.mock('@/lib/llm-settings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/llm-settings')>('@/lib/llm-settings');
  return { ...actual, readLlmSettings: vi.fn() };
});

// getEnv mock with DEFAULT — logger.ts module-level `getEnv()` reads it
// at import time, 不是在 beforeEach. 必须在 factory 里默认有值.
vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    getEnv: vi.fn().mockReturnValue(hoisted.DEFAULT_TEST_ENV),
  };
});

import { callLlm } from '@/lib/llm';
import { readLlmSettings } from '@/lib/llm-settings';
import { getEnv } from '@/lib/env';

const mockReadSettings = vi.mocked(readLlmSettings);
const mockGetEnv = vi.mocked(getEnv);

describe('callLlm anthropic ↔ OpenAI fallback (integration, v0.6.1 wiring)', () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockOpenAICreate.mockReset();
    mockReadSettings.mockReset();
    mockGetEnv.mockReset();
    // 重置为 default (per-test 后面 mockReturnValue override)
    mockGetEnv.mockReturnValue(DEFAULT_TEST_ENV as never);
  });

  it('1. anthropic success → returns anthropic out, OpenAI client not constructed', async () => {
    mockReadSettings.mockResolvedValue({
      provider: 'anthropic',
      apiKey: 'sk-ant-settings-1234567890',
    });
    mockGetEnv.mockReturnValue({ ...DEFAULT_TEST_ENV, OPENAI_API_KEY: 'sk-openai-1234567890' } as never);
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'anthropic-out' }],
    });

    const out = await callLlm({ messages: [{ role: 'user', content: 'x' }] });

    expect(out).toBe('anthropic-out');
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    expect(mockOpenAICreate).not.toHaveBeenCalled();
  });

  // anthropic retry 内部 (1s+2s+4s) + fallback retry (1s+2s) = 10s 总时长.
  // vitest 默认 5s timeout, 测 retry 路径显式拉到 30s 防误报.
  it('2. anthropic 503 + OPENAI key present → falls back to OpenAI (returns openai out)', async () => {
    mockReadSettings.mockResolvedValue({
      provider: 'anthropic',
      apiKey: 'sk-ant-settings-1234567890',
    });
    mockGetEnv.mockReturnValue({ ...DEFAULT_TEST_ENV, OPENAI_API_KEY: 'sk-openai-1234567890' } as never);
    // anthropic 503 retry 3 次都拒 → 最后抛 503 → wrapper 视为 infra → fallback
    mockAnthropicCreate.mockRejectedValue({ status: 503, message: '503 Service Unavailable' });
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: 'openai-out' } }],
    });

    const out = await callLlm({ messages: [{ role: 'user', content: 'x' }] });

    expect(out).toBe('openai-out');
    // callAnthropic 内部 3-attempt retry (attempt 0/1/2, 第 3 次 throw 跳出)
    expect(mockAnthropicCreate.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mockAnthropicCreate.mock.calls.length).toBeLessThanOrEqual(3);
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('3. anthropic 503 + OPENAI key absent → rethrows anthropic error (no silent fallback)', async () => {
    mockReadSettings.mockResolvedValue({
      provider: 'anthropic',
      apiKey: 'sk-ant-settings-1234567890',
    });
    // OPENAI_API_KEY 空字符串 (default state — '=' no override)
    mockAnthropicCreate.mockRejectedValue({ status: 503, message: '503 Service Unavailable' });

    await expect(
      callLlm({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ status: 503 });

    expect(mockOpenAICreate).not.toHaveBeenCalled();
  }, 30_000);

  it('4. anthropic 400 (logic error) → no fallback, throws 400 (4xx is not infra)', async () => {
    mockReadSettings.mockResolvedValue({
      provider: 'anthropic',
      apiKey: 'sk-ant-settings-1234567890',
    });
    mockGetEnv.mockReturnValue({ ...DEFAULT_TEST_ENV, OPENAI_API_KEY: 'sk-openai-1234567890' } as never);
    // 4xx logic 错: callAnthropic 立即 break out (不 retry), 抛 400.
    // withAnthropicFallback wrapper 视 4xx 为 non-infra → 不 fallback → re-throw 原.
    mockAnthropicCreate.mockRejectedValue({ status: 400, message: '400 Bad Request: invalid schema' });

    await expect(
      callLlm({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ status: 400 });

    expect(mockOpenAICreate).not.toHaveBeenCalled();
    // callAnthropic break 立即抛, 只调一次 (not 3 retries)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
  });
});
