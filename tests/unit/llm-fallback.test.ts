// P2 OpenRouter fallback tests for callLlm() → minimax path.
//
// test strategy:
//   1. mock @/lib/llm-settings so callLlm → resolveConfig → provider='minimax'
//   2. mock global.fetch (callMinimax 用) for HTTP response control
//   3. mock openai SDK (callOpenRouter 用) for OpenRouter response
//   4. mock @/lib/env (callMinimaxWithFallback 内 getEnv() 取 OPENROUTER_*)
//
// sliding window 是 llm.ts module-level state，所以 frequency counter 测试
// 用 vi.resetModules() + vi.doMock() 在新模块实例里跑，让 counter 从 0 开始。
//
// PR 计划详见 docs/refactor-plan-v0.1.md §7.1。

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/llm-settings', () => ({
  readLlmSettings: vi.fn().mockResolvedValue({
    provider: 'minimax',
    model: 'MiniMax-M3',
    baseURL: 'https://api.minimaxi.com/v1',
    apiKey: 'minimax-test-key-1234567890',
  }),
  DEFAULT_PROVIDER: 'anthropic',
  PROVIDER_DEFAULT_BASEURL: {
    'anthropic': null,
    'openai-compatible': 'https://api.openai.com/v1',
    'minimax': 'https://api.minimaxi.com/v1',
  },
}));

vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(),
}));

// logger module 调用 getEnv() 拿 LOG_LEVEL 在 module init; mock 整个 logger 跳过 pino 设置链
vi.mock('@/lib/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

const mockOpenaiCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockOpenaiCreate } },
  })),
}));

import { getEnv } from '@/lib/env';
import { callLlm } from '@/lib/llm';

const mockedGetEnv = vi.mocked(getEnv);

let mockFetch: ReturnType<typeof vi.fn>;

describe('callLlm minimax + OpenRouter fallback (P2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  it('1. minimax success returns minimax response; no fallback triggered', async () => {
    mockedGetEnv.mockReturnValue({} as any);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        base_resp: { status_code: 0, status_msg: '' },
        choices: [{ message: { content: 'minimax-out' } }],
      }),
    });
    const out = await callLlm({ messages: [{ role: 'user', content: 'hi' }] });
    expect(out).toBe('minimax-out');
    expect(mockOpenaiCreate).not.toHaveBeenCalled();
  });

  it('2. HTTP 4xx from minimax triggers OpenRouter fallback (key configured)', async () => {
    mockedGetEnv.mockReturnValue({
      OPENROUTER_API_KEY: 'or-test-key-1234567890',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENROUTER_FALLBACK_MODEL: 'minimax/MiniMax-M3',
    } as any);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 402,
      text: async () => 'Payment Required',
    });
    mockOpenaiCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'or-out-402' } }],
    });
    const out = await callLlm({ messages: [{ role: 'user', content: 'hi' }] });
    expect(out).toBe('or-out-402');
    expect(mockOpenaiCreate).toHaveBeenCalledTimes(1);
    // baseURL 应该是 OpenRouter
    expect(mockOpenaiCreate.mock.calls[0][0]).toMatchObject({
      model: 'minimax/MiniMax-M3',
    });
  });

  it('3. base_resp business code ≥ 4000 triggers OpenRouter fallback', async () => {
    mockedGetEnv.mockReturnValue({
      OPENROUTER_API_KEY: 'or-test-key-1234567890',
    } as any);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        base_resp: { status_code: 4023, status_msg: 'biz failure' },
      }),
    });
    mockOpenaiCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'or-out-4023' } }],
    });
    const out = await callLlm({ messages: [{ role: 'user', content: 'hi' }] });
    expect(out).toBe('or-out-4023');
    expect(mockOpenaiCreate).toHaveBeenCalledTimes(1);
  });

  it('4. base_resp business code 1008 does NOT trigger fallback (plan strict: only 4xxx)', async () => {
    mockedGetEnv.mockReturnValue({
      OPENROUTER_API_KEY: 'or-test-key-1234567890',
    } as any);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        base_resp: { status_code: 1008, status_msg: 'insufficient balance' },
      }),
    });
    // callMinimax 现有实现对业务码 1xxx 也走 retry 路径 (status=100<400 不 break),
    // 3 attempts × exponential backoff ≈ 7s; 给这个测试单独的 timeout.
    await expect(callLlm({
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/minimax 1008/);
    expect(mockOpenaiCreate).not.toHaveBeenCalled();
  }, 15_000);

  it('5. OPENROUTER_API_KEY unset passes through original error (no fallback when key missing)', async () => {
    mockedGetEnv.mockReturnValue({} as any); // 三个 OPENROUTER_* 全部缺失
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 402,
      text: async () => 'Payment Required',
    });
    await expect(callLlm({
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/minimax 402/);
    expect(mockOpenaiCreate).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// frequency counter — sliding window 必须独立 fresh module 实例 (counter = [])
// ────────────────────────────────────────────────────────────────
describe('P2 fallback sliding window frequency counter', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('@/lib/env', () => ({
      getEnv: vi.fn().mockReturnValue({
        OPENROUTER_API_KEY: 'or-test-key-1234567890',
        OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
        OPENROUTER_FALLBACK_MODEL: 'minimax/MiniMax-M3',
      }),
    }));
    vi.doMock('@/lib/logger', () => ({
      logger: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
      },
    }));
    vi.doMock('@/lib/llm-settings', () => ({
      readLlmSettings: vi.fn().mockResolvedValue({
        provider: 'minimax',
        model: 'MiniMax-M3',
        baseURL: 'https://api.minimaxi.com/v1',
        apiKey: 'minimax-test-key-1234567890',
      }),
      DEFAULT_PROVIDER: 'anthropic',
      PROVIDER_DEFAULT_BASEURL: {
        'anthropic': null,
        'openai-compatible': 'https://api.openai.com/v1',
        'minimax': 'https://api.minimaxi.com/v1',
      },
    }));
    vi.doMock('openai', () => ({
      default: vi.fn().mockImplementation(() => ({
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: 'or-freq-out' } }],
            }),
          },
        },
      })),
    }));
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => 'Payment Required',
    }) as unknown as typeof fetch;
  });

  it('6. fast-fails on the 6th fallback within window (≥ FALLBACK_MAX_RECENT)', async () => {
    // 重 import 让 fallbackRecent = [] 初始化
    const { callLlm: freshCallLlm } = await import('@/lib/llm');

    // 前 5 次都触发 fallback 都成功
    for (let i = 0; i < 5; i++) {
      const out = await freshCallLlm({ messages: [{ role: 'user', content: 'hi' }] });
      expect(out).toBe('or-freq-out');
    }

    // 第 6 次 fast-fail (sliding window 已满)
    await expect(freshCallLlm({
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/rate-limit/);
  });
});
