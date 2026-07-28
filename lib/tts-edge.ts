// v0.6.1 TTS auto-downgrade (spec §4.3) — Edge TTS fallback helper.
//
// 'node-edge-tts' (MIT, active) 接 Microsoft Edge 浏览器内置 TTS endpoint
// (wss://speech.platform.bing.com/.../readaloud/edge/v1) — 不需 API key, 用
// 临时 DRM token. 服务端 quota 不公开 (但不存在 Azure region quota 那种
// per-tier 限制), 只对滥用限频.
//
// 现状 (典型 SaaS / 单 self-host):
//   - 默认 retry 10s (node-edge-tts default) 容易 timeout 5xx
//   - 服务 weekly 1次保 debug 调度变更 — 不稳定
//   - 不需 env key (vs Azure SPEECH_KEY + REGION 必填)
//
// 这里只 wrap 'node-edge-tts' 让 caller 用同 TtsOptions shape; 无 retry/fallback
// 逻辑 — 这是 lib/ 层, 决策 (Azure ↔ Edge) 在 lib/tts-fallback.ts 上层.

import { EdgeTTS } from 'node-edge-tts';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface EdgeTtsOptions {
  text: string;
  /** 默认 'zh-CN-XiaoyiNeural' — 同 zh-CN-XiaoxiaoNeural 风格 (female young), Azure 不支持 Xiaoyi 但 Xiaoxiao 等价. */
  voice?: string;
  /** 默认 'audio-24khz-48kbitrate-mono-mp3' — 同 Azure 'mp3' outputFormat. */
  outputFormat?: string;
  /** 网络 timeout ms (node-edge-tts default 10000). */
  timeoutMs?: number;
}

/**
 * Edge TTS → ArrayBuffer (audio bytes; 同 synthesizeAzure 出参).
 *
 * 'node-edge-tts' 的 'ttsPromise' 接口硬要写文件 (audioPath) — 没法 in-memory
 * 拿. 我们写 tmp file → read buffer → unlink, 三步合成.
 *
 * @throws 'node-edge-tts' 内部 reject (网络 timeout / DRM token fail / voice 不支持)
 */
export async function synthesizeEdge(opts: EdgeTtsOptions): Promise<ArrayBuffer> {
  const tts = new EdgeTTS({
    voice: opts.voice ?? 'zh-CN-XiaoyiNeural',
    outputFormat: opts.outputFormat ?? 'audio-24khz-48kbitrate-mono-mp3',
    timeout: opts.timeoutMs ?? 10_000,
  });

  // tmp 文件路径; randomUUID 避免并发调用撞名
  const tmpPath = path.join(tmpdir(), `edge-tts-${randomUUID()}.mp3`);

  try {
    // node-edge-tts@ttsPromise 返 Promise<unknown> — resolve undefined 当写完
    await tts.ttsPromise(opts.text, tmpPath);
    const buf = await fs.readFile(tmpPath);
    // Buffer → ArrayBuffer (zero-copy slice, 只移 view)
    // Node Buffer 内存 layout 与 ArrayBuffer 不同 (offset 在 Buffer.byteOffset,
    // length 在 Buffer.byteLength). ArrayBuffer 应是独立 buffer: 用 Buffer 的
    // underlying ArrayBuffer (Node 4+) + slice 到正确范围.
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  } finally {
    // best-effort cleanup; 失败不影响 throw (主要 message 是真 throw)
    await fs.unlink(tmpPath).catch(() => {
      // intentionally silent — tmp cleanup 是 best-effort
    });
  }
}
