import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted: lib/tts-fallback.ts (已引入 worker/phases/tts-azure.ts 经
// synthesizeToBufferWithFallback) import logger; logger module-level `const env
// = getEnv()` 在 import 时立刻跑 — 必须在 mock factory 里有 default env.
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
  },
}));

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    getEnv: vi.fn().mockReturnValue(hoisted.DEFAULT_TEST_ENV),
  };
});

// mock 整个 SDK；factory hoist 后在 first-import 时 evaluate
vi.mock('microsoft-cognitiveservices-speech-sdk', () => {
  const synthInstance = {
    speakTextAsync: vi.fn(),
    close: vi.fn(),
  };
  return {
    SpeechConfig: { fromSubscription: vi.fn().mockReturnValue({}) },
    SpeechSynthesizer: vi.fn(() => synthInstance),
    ResultReason: { SynthesizingAudioCompleted: 'completed' },
    SpeechSynthesisOutputFormat: { Audio16Khz32KBitRateMonoMp3: 'mp3-format' },
  };
});

// vi.mocked 包装 imported instance 用于 mock 行为配置
import { getEnv } from '@/lib/env';
import * as speechsdk from 'microsoft-cognitiveservices-speech-sdk';
// 关键：vi.mocked 在 import 之后才能 wrap，因为 vi.mock hoists
const _getEnv = getEnv; // silence "declared but never used"

const mockedGetEnv = vi.mocked(getEnv);
const MockedConfig = vi.mocked(speechsdk.SpeechConfig);
const MockedSynthesizer = vi.mocked(speechsdk.SpeechSynthesizer);

describe('synthesizeToBuffer (Azure TTS, P0 POC)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockedConfig.fromSubscription.mockReturnValue({} as never);
  });

  it('1. happy path: returns ArrayBuffer on SynthesizingAudioCompleted', async () => {
    mockedGetEnv.mockReturnValue({
      AZURE_SPEECH_KEY: 'azure-key-1234567890',
      AZURE_SPEECH_REGION: 'eastasia',
    } as never);

    const fakeBuffer = new ArrayBuffer(16);
    MockedSynthesizer.mockImplementation(
      () =>
        ({
          speakTextAsync: vi.fn().mockImplementation((_t: string, onResult: (r: unknown) => void) => {
            onResult({
              reason: speechsdk.ResultReason.SynthesizingAudioCompleted,
              audioData: fakeBuffer,
            });
          }),
          close: vi.fn(),
        }) as never,
    );

    const out = await synthesizeToBuffer({ text: '你好' });
    expect(out).toBe(fakeBuffer);
    expect(MockedConfig.fromSubscription).toHaveBeenCalledWith('azure-key-1234567890', 'eastasia');
  });

  it('2. throws when AZURE_SPEECH_KEY missing', async () => {
    mockedGetEnv.mockReturnValue({
      AZURE_SPEECH_REGION: 'eastasia',
    } as never);

    await expect(synthesizeToBuffer({ text: 'hi' })).rejects.toThrow(/AZURE_SPEECH_KEY \/ AZURE_SPEECH_REGION/);
    expect(MockedSynthesizer).not.toHaveBeenCalled();
  });

  it('3. throws when SDK reports non-completed reason (with synthesizer.close called)', async () => {
    mockedGetEnv.mockReturnValue({
      AZURE_SPEECH_KEY: 'azure-key-1234567890',
      AZURE_SPEECH_REGION: 'eastasia',
    } as never);

    const closeSpy = vi.fn();
    MockedSynthesizer.mockImplementation(
      () =>
        ({
          speakTextAsync: vi.fn().mockImplementation((_t: string, onResult: (r: unknown) => void) => {
            onResult({ reason: 'failed', errorCode: 'X', errorDetails: 'bad voice id' });
          }),
          close: closeSpy,
        }) as never,
    );

    await expect(synthesizeToBuffer({ text: 'hi' })).rejects.toThrow(/TTS failed/);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

import { synthesizeToBuffer } from '@/worker/phases/tts-azure';
