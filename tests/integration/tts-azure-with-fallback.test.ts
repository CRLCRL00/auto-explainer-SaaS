// v0.6.1 integration: synthesizeToBufferWithFallback (Azure → Edge, spec §4.3).
//
// 4 paths 覆盖:
//   1. Azure 成功 → 直接返, Edge 不调
//   2. Azure 5xx / quota / region outage (非 config) → fallback Edge 走通
//   3. Azure config 错 (env 缺 / key 无效 / 'invalid subscription') → 透传, 不 fallback
//      (用户配错的错不能 silent fallback 到 Edge — 真用户错)
//   4. Azure 5xx + Edge 也 5xx → 透传 Edge 错 (last error wins)
//
// 'microsoft-cognitiveservices-speech-sdk' 用 vi.mock module-level hoist.
// node-edge-tts 也 mock (WebSocket 网络, 真跑会 timeout / 受 DRM 限).
// 'lib/tts-fallback' 用实际 wrapper (有 wrapper 行为测试已存在 unit test).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://test@127.0.0.1:5432/test';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-env-fallback-1234567890';
  process.env.BASIC_AUTH_USER ??= 'admin';
  process.env.BASIC_AUTH_PASS ??= 'changeme';
  process.env.CREATOMATE_API_KEY ??= 'creato-test-key-1234567890';
  process.env.AZURE_SPEECH_KEY ??= 'azure-test-key-1234567890';
  process.env.AZURE_SPEECH_REGION ??= 'eastasia';
});

// vi.hoisted 让 mock factories hoist-time 可引用变量.
const hoisted = vi.hoisted(() => ({
  // 'synthesizeToBuffer' 是 worker/phases/tts-azure.ts 内部函数 — 我们想 mock 它
  // 整个 module 来控制 Azure 行为. 用 synthesizeToBufferWithFallback export — 那边
  // import 内部函数.
  mockSpeakTextAsync: vi.fn(),
  mockSyncWrite: vi.fn(),  // debug, 实际不起作用 (mockSpeakTextAsync return value)
  mockSynthesizeEdge: vi.fn(),
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
    TRIGGER_DEPLOYMENT: 'self-hosted' as const,
    RUN_TRIGGER_DEV: '0' as const,
    AZURE_SPEECH_KEY: 'azure-test-key-1234567890',
    AZURE_SPEECH_REGION: 'eastasia',
  },
}));

const { DEFAULT_TEST_ENV } = hoisted;

// Azure SDK module-level mock — 控制 speakTextAsync callback 行为.
vi.mock('microsoft-cognitiveservices-speech-sdk', () => ({
  SpeechConfig: class {
    static fromSubscription(_key: string, _region: string): object {
      return {};
    }
  },
  SpeechSynthesizer: class {
    speakTextAsync(
      text: string,
      onResult: (r: { reason: string; audioData: ArrayBuffer; errorCode?: string; errorDetails?: string }) => void,
      _onError: (err: string) => void,
    ): void {
      hoisted.mockSpeakTextAsync(text, onResult, _onError);
    }
    close(): void {
      // no-op for test
    }
  },
  ResultReason: { SynthesizingAudioCompleted: 'SynthesizingAudioCompleted' },
  SpeechSynthesisOutputFormat: { Audio16Khz32KBitRateMonoMp3: 'Audio16Khz32KBitRateMonoMp3' },
}));

// Edge TTS module-level mock — 不真发 WebSocket.
vi.mock('@/lib/tts-edge', () => ({
  synthesizeEdge: hoisted.mockSynthesizeEdge,
}));

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    getEnv: vi.fn().mockReturnValue(hoisted.DEFAULT_TEST_ENV),
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { synthesizeToBufferWithFallback } from '@/worker/phases/tts-azure';
import { synthesizeEdge } from '@/lib/tts-edge';
import { getEnv } from '@/lib/env';

const mockSpeakTextAsync = hoisted.mockSpeakTextAsync;
const mockSynthesizeEdge = vi.mocked(synthesizeEdge);
const mockGetEnv = vi.mocked(getEnv);

describe('synthesizeToBufferWithFallback (v0.6.1, spec §4.3 TTS Azure → Edge)', () => {
  beforeEach(() => {
    mockSpeakTextAsync.mockReset();
    mockSynthesizeEdge.mockReset();
    mockGetEnv.mockReset();
    mockGetEnv.mockReturnValue(DEFAULT_TEST_ENV as never);
  });

  it('1. Azure 成功 → returns azure buf, Edge 不构造', async () => {
    const azureBuf = new ArrayBuffer(8);
    mockSpeakTextAsync.mockImplementation((_text, onResult) => {
      // reason 用真实 SDK 字符串值 (mock factory 注入的)
      onResult({ reason: 'SynthesizingAudioCompleted', audioData: azureBuf });
    });

    const out = await synthesizeToBufferWithFallback({ text: 'hello' });

    expect(out).toBe(azureBuf);
    expect(mockSpeakTextAsync).toHaveBeenCalledTimes(1);
    expect(mockSynthesizeEdge).not.toHaveBeenCalled();
  });

  it('2. Azure 5xx / quota / region outage → fallback Edge 走通', async () => {
    const azureErr = new Error('5xx internal server error: quota exceeded');
    const edgeBuf = new ArrayBuffer(16);
    mockSpeakTextAsync.mockImplementation((_text, _onResult, onError) => {
      // onError 路径 — Azure SDK reject shape
      onError(azureErr.message);
    });
    mockSynthesizeEdge.mockResolvedValue(edgeBuf);

    const out = await synthesizeToBufferWithFallback({ text: 'hello' });

    expect(out).toBe(edgeBuf);
    expect(mockSpeakTextAsync).toHaveBeenCalledTimes(1);
    expect(mockSynthesizeEdge).toHaveBeenCalledTimes(1);
    // Edge voice 映射: Azure 'zh-CN-XiaoxiaoNeural' → Edge 'zh-CN-XiaoyiNeural'
    expect(mockSynthesizeEdge).toHaveBeenCalledWith(
      expect.objectContaining({ voice: 'zh-CN-XiaoyiNeural' }),
    );
  });

  it('3. Azure config 错 (env 缺 / key invalid) → rethrow 原 err, NOT fallback', async () => {
    const configErr = new Error('AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not configured');
    mockSpeakTextAsync.mockImplementation((_text, onResult) => {
      onResult({ reason: 'canceled', audioData: new ArrayBuffer(0) });
    });

    // Force 'getEnv' to throw for this call — simulate 'env not configured' path.
    // synthesizeToBuffer 里开头 IF NOT env.AZURE_SPEECH_KEY 时先 throw, 之前不到
    // speakTextAsync. 这里直接抛 error before SDK 调用.
    mockGetEnv.mockImplementation(() => {
      throw new Error('AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not configured');
    });

    // Override the env to remove azure keys — synthesizeToBuffer throw config err.
    void configErr;  // suppress unused warning

    await expect(
      synthesizeToBufferWithFallback({ text: 'hello' }),
    ).rejects.toThrow(/AZURE_SPEECH_KEY .* not configured/);

    // 这是 env 配置错, 不应 fallback (用 isAzureConfigError 守住)
    expect(mockSynthesizeEdge).not.toHaveBeenCalled();
  });

    // 测试 3 走了 上面 'azure config 错' 这里手动跳过 cover
    // 只是清理 mockGetEnv mockImplementation 让后续 it 不受影响.
    it('4. Azure 5xx + Edge 也 fail → 透传 Edge 错 (last error wins)', async () => {
    const azureErr = new Error('503 region outage');
    const edgeErr = new Error('EDGE_TTS_TIMEOUT: 10000ms');
    mockSpeakTextAsync.mockImplementation((_text, _onResult, onError) => {
      onError(azureErr.message);
    });
    mockSynthesizeEdge.mockRejectedValue(edgeErr);

    await expect(
      synthesizeToBufferWithFallback({ text: 'hello' }),
    ).rejects.toThrow(/EDGE_TTS_TIMEOUT/);

    // Edge 仅调一次 (wrapper 限 1 retry cycle)
    expect(mockSynthesizeEdge).toHaveBeenCalledTimes(1);
  });
});
