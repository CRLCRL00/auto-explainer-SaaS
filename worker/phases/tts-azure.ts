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
      (result: speechsdk.SpeechSynthesisResult) => {
        synthesizer.close();
        // SpeechSynthesisResult.reason 是 SpeechSDK.ResultReason enum,
        // 不是 plain string. 之前 inline \`{ reason: string }\` 把 enum 退化成
        // string, TS2367 比较报错. 现在用 SDK 类型避免类型收缩.
        if (result.reason === speechsdk.ResultReason.SynthesizingAudioCompleted) {
          resolve(result.audioData);
        } else {
          reject(new Error(`TTS failed: ${result.errorCode} ${result.errorDetails ?? ''}`));
        }
      },
      (err) => {
        synthesizer.close();
        reject(new Error(`TTS error: ${err}`));
      },
    );
  });
}
