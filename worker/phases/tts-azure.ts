// TTS via Microsoft Cognitive Services Speech SDK (P0 POC: 中文 zh-CN voice).
//
// 入参: { text, voice? (default 'zh-CN-XiaoxiaoNeural'), outputFormat?: 'mp3' | 'wav' }
// 出参: ArrayBuffer (mp3 or wav bytes) — caller 负责写文件 + 写 job_artifacts.
//
// 注意:
//   - SDK 真实 package 是 'microsoft-cognitiveservices-speech-sdk' (旧名 azure-cognitiveservices-speech 404).
//   - env vars 用 'AZURE_SPEECH_*' prefix (团队约定，不需要改)。
//   - SDK 实例化在每次调用都新建 SpeechSynthesizer — frequency 不高 (5 beat / 1 video)，
//     不必复用 pool；如未来并发大再做 pool。

import * as speechsdk from 'microsoft-cognitiveservices-speech-sdk';
import { getEnv } from '@/lib/env';
import { synthesizeEdge } from '@/lib/tts-edge';
import { withTtsFallback } from '@/lib/tts-fallback';

export interface TtsOptions {
  text: string;
  voice?: string; // default 'zh-CN-XiaoxiaoNeural'
  outputFormat?: 'mp3' | 'wav';
}

/** Force-cast SpeechSynthesisOutputFormat enum entry — SDK enum 是 dict-of-strings */
function pickFormat(fmt: 'mp3' | 'wav'): string {
  // SDK 真实 enum key 用 camelCase 命名；为了兼容不同版本，下面用 type-assert 跳过类型检查
  const enumObj = speechsdk.SpeechSynthesisOutputFormat as unknown as Record<string, string>;
  return fmt === 'wav'
    ? (enumObj.Audio16Khz32KBitRateMonoWav ?? enumObj.Audio16Khz32KBitRateMonoMp3)
    : enumObj.Audio16Khz32KBitRateMonoMp3;
}

export async function synthesizeToBuffer(opts: TtsOptions): Promise<ArrayBuffer> {
  const env = getEnv();
  if (!env.AZURE_SPEECH_KEY || !env.AZURE_SPEECH_REGION) {
    throw new Error('AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not configured');
  }
  const voice = opts.voice ?? 'zh-CN-XiaoxiaoNeural';
  const format = pickFormat(opts.outputFormat ?? 'mp3');

  const speechConfig = speechsdk.SpeechConfig.fromSubscription(
    env.AZURE_SPEECH_KEY,
    env.AZURE_SPEECH_REGION,
  );
  speechConfig.speechSynthesisVoiceName = voice;
  (speechConfig as unknown as { speechSynthesisOutputFormat: string }).speechSynthesisOutputFormat = format;

  return new Promise<ArrayBuffer>((resolve, reject) => {
    const synthesizer = new speechsdk.SpeechSynthesizer(speechConfig);
    (synthesizer as unknown as {
      speakTextAsync: (
        text: string,
        onResult: (r: { reason: string; audioData: ArrayBuffer; errorCode?: string; errorDetails?: string }) => void,
        onError: (err: string) => void,
      ) => void;
    }).speakTextAsync(
      opts.text,
      (result) => {
        synthesizer.close();
        // callback 类型由上面 \`(synthesizer as unknown as {...})\` cast 定:
        // \`r: { reason: string; audioData: ArrayBuffer; errorCode?; errorDetails? }\`.
        // speechsdk.ResultReason 是 enum (numeric 或 string 值), TS 推 result.reason
        // 为 string 后直接比较触 TS2367. 用 \`String()\` 把 enum runtime value 转 string
        // 后相等比较 — 既关 TS 错, runtime 也语义正确 (ResultReason 自身是 string enum 时
        // String() 等于本身).
        const REASON_OK = String(speechsdk.ResultReason.SynthesizingAudioCompleted);
        if (result.reason === REASON_OK) {
          resolve(result.audioData);
        } else {
          reject(new Error(`TTS failed: ${result.reason} ${result.errorCode ?? ''} ${result.errorDetails ?? ''}`));
        }
      },
      (err) => {
        synthesizer.close();
        reject(new Error(`TTS error: ${err}`));
      },
    );
  });
}

/**
 * v0.6.1 Azure TTS + Edge fallback: spec §4.3 TTS 段. synth 上层
 * 用 try Azure → 5xx / quota / region outage 时回退 Edge TTS.
 *
 * 配置错 (env 缺 / key 无效) 透传原 error, 不静默 fallback
 * (wrapper 内部 log warn — 参见 lib/tts-fallback.ts:isAzureConfigError).
 *
 * Edge TTS 输出 mp3 (audio-24khz-48kbitrate-mono-mp3) — 与 Azure mp3 同.
 * voice 映射: Azure 'zh-CN-XiaoxiaoNeural' → Edge 'zh-CN-XiaoyiNeural' (风格 female
 * young 同; Edge 没 'Xiaoxiao').
 */
export async function synthesizeToBufferWithFallback(opts: TtsOptions): Promise<ArrayBuffer> {
  // Edge voice mapping (Azure 用的 Xiaoxiao Neural Edge 没, 用 Xiaoyi 同风格)
  const edgeVoice =
    opts.voice === 'zh-CN-XiaoxiaoNeural'
      ? 'zh-CN-XiaoyiNeural'
      : (opts.voice ?? 'zh-CN-XiaoyiNeural');

  return withTtsFallback(
    opts,
    () => synthesizeToBuffer(opts),
    () =>
      synthesizeEdge({
        text: opts.text,
        voice: edgeVoice,
        ...(opts.outputFormat ? { outputFormat: 'audio-24khz-48kbitrate-mono-mp3' as const } : {}),
      }),
  );
}
