import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/env', () => ({ getEnv: vi.fn() }));

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
