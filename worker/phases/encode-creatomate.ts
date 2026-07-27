// Creatomate SaaS render path (P0 全量: 默认 render path).
//
// 设计:
//   - frames 是 Puppeteer record 阶段 (32 buffer, 30fps, ~30s) 输出的 PNG 序列.
//   - 读 script.json (ScriptWriter 产物) → 提取 caption 字幕层 (per-beat Text elements)
//   - 可选地调用 Azure TTS 合成 audio.mp3, 加为 Audio element.
//   - submit 给 Creatomate.Source → render → download mp4 → 落 job_artifacts.
//   - 写 4 个 lifecycle events (creatomate_render_started/_progress/_completed/_failed).
//
// 入参: jobId (string) — 与原 phaseEncode 同签名 (hard cut 兼容性).
// 出参: storage/jobs/{jobId}/video.mp4 + job_artifacts(kind='mp4') 行.
//
// 环境依赖 (P0 全量, lib/env.ts 全部 required):
//   - CREATOMATE_API_KEY 必填
//   - CREATOMATE_BASE_URL / TEMPLATE_ID / POLL_*: optional, 有默认值
//   - AZURE_SPEECH_KEY + AZURE_SPEECH_REGION: optional. 配齐时合成中文 TTS audio.
//   - script.json 缺失时降级为无字幕 (templates fallback).
//
// SDK 真实 package: 'creatomate' (不是 @creatomate/creatomate — 后者 404).

import path from 'node:path';
import fs from 'node:fs/promises';
import Creatomate from 'creatomate';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { getDb } from '@/lib/db';
import { jobArtifacts, jobs } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { safeRecordEvent, CreatomateEvents } from '@/lib/job-events';
import { synthesizeToBuffer } from './tts-azure';

export const DEFAULT_OUTPUT_WIDTH = 1080;
export const DEFAULT_OUTPUT_HEIGHT = 1920;
export const DEFAULT_DURATION_SEC = 30;
export const RENDER_TIMEOUT_SEC = 600; // 10 分钟 (SDK doc)

export interface EncodeCreatomateOptions {
  jobDir?: string;
}

interface ResolvedScript {
  title: string;
  beats: Array<{ caption: string; tts_text: string }>;
}

/**
 * Best-effort 读 script.json，缺失 / 解析失败时返回 null.
 * 老 job / POC job 没 script 时仍能渲染（无字幕）— 不阻塞主流程.
 */
async function readScriptSafe(jobDir: string): Promise<ResolvedScript | null> {
  const scriptPath = path.join(jobDir, 'script.json');
  try {
    const raw = await fs.readFile(scriptPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as { beats?: unknown }).beats)
    ) {
      return null;
    }
    const title = (parsed as { title?: unknown }).title;
    const beats = (parsed as { beats: Array<{ caption?: unknown; tts_text?: unknown }> }).beats
      .filter((b) => typeof b.caption === 'string' && typeof b.tts_text === 'string')
      .map((b) => ({ caption: b.caption as string, tts_text: b.tts_text as string }));
    if (typeof title !== 'string' || beats.length === 0) return null;
    return { title, beats };
  } catch {
    return null;
  }
}

export async function phaseEncodeCreatomate(
  jobId: string,
  opts: EncodeCreatomateOptions = {},
): Promise<void> {
  const env = getEnv();
  if (!env.CREATOMATE_API_KEY || env.CREATOMATE_API_KEY.length < 10) {
    // lib/env.ts 升 required 后正常 schema parse 也会 throw, 但保留这条直接
    // 检查可在 tests 绕过 schema 时仍被覆盖. 错误信息更可读.
    throw new Error(
      '[P0 全量] CREATOMATE_API_KEY missing or too short — set it in .env.local',
    );
  }

  const jobDir = opts.jobDir ?? path.join(process.cwd(), 'storage', 'jobs', jobId);
  const framesDir = path.join(jobDir, 'frames');

  // 1. 取首张 PNG frame 作为静态背景 (P0 POC 简化: 不拼 frame 序列).
  const frameNames = await fs.readdir(framesDir);
  const pngFrames = frameNames.filter((n) => n.endsWith('.png')).sort();
  if (pngFrames.length === 0) {
    throw new Error(`[${jobId}] no PNG frames in ${framesDir} — record phase broken?`);
  }
  const firstFrame = pngFrames[0];

  // 2. Best-effort 读 script.json (caption + TTS 输入).
  const script = await readScriptSafe(jobDir);

  // 3. Best-effort TTS 合成 (Azure 配置齐 + script 存在).
  let audioPath: string | null = null;
  if (env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION && script) {
    try {
      const narration = script.beats.map((b) => b.tts_text).join('。 ');
      const buf = await synthesizeToBuffer({ text: narration, voice: 'zh-CN-XiaoxiaoNeural' });
      audioPath = path.join(jobDir, 'audio.mp3');
      await fs.writeFile(audioPath, Buffer.from(buf));
    } catch (err) {
      logger.warn(
        { jobId, err: err instanceof Error ? err.message : String(err) },
        'TTS skipped (Azure unreachable or key invalid); audio element dropped',
      );
      audioPath = null;
    }
  }

  logger.info(
    {
      jobId,
      framesFound: pngFrames.length,
      firstFrame,
      scriptBeats: script?.beats.length ?? 0,
      hasAudio: !!audioPath,
      renderWidth: DEFAULT_OUTPUT_WIDTH,
      renderHeight: DEFAULT_OUTPUT_HEIGHT,
    },
    'creatomate encode starting',
  );

  // 4. 组装 elements — Image + Text (caption per beat) + Audio (optional).
  //    Creatomate 顶层 import 提供所有 element classes; 用 loosish any 兼容不同
  //    elements override set (SchemaType 差异不影响 runtime).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const elements: Creatomate.ElementBase<any>[] = [
    new Creatomate.Image({
      source: `file://${path.join(framesDir, firstFrame)}`,
      fit: 'cover',
    }),
  ];

  if (script) {
    for (let i = 0; i < script.beats.length; i++) {
      const caption = script.beats[i].caption;
      elements.push(
        new Creatomate.Text({
          text: caption,
          width: '90%',
          height: 'auto',
          xAlignment: '50%',
          yAlignment: '90%', // 屏幕底部
          xPadding: '3 vmin',
          yPadding: '5 vmin',
          fontFamily: 'Aileron',
          fontWeight: 700,
          fontSize: '4.5 vh',
          fillColor: '#ffffff',
          shadow: new Creatomate.Shadow('rgba(0,0,0,0.7)', '1.4 vmin'),
          // duration 默认继承 source — caption 全程可见
        }),
      );
      void i; // ununsed — 留作未来 per-beat 时间码编排
    }
  }

  if (audioPath) {
    elements.push(new Creatomate.Audio({ source: `file://${audioPath}` }));
  }

  // 5. Submit render + 写 started event.
  await safeRecordEvent(jobId, 'creatomate_rendering', CreatomateEvents.RenderStarted, {
    templateId: env.CREATOMATE_TEMPLATE_ID,
    elementCount: elements.length,
  });

  const client = new Creatomate.Client(env.CREATOMATE_API_KEY);
  const source = new Creatomate.Source({
    outputFormat: 'mp4',
    width: DEFAULT_OUTPUT_WIDTH,
    height: DEFAULT_OUTPUT_HEIGHT,
    duration: DEFAULT_DURATION_SEC,
    frameRate: 30,
    elements,
  });

  // 6. SDK 内置 polling; status=succeeded 才 resolve; timeout=10min.
  let render: Creatomate.Render | undefined;
  try {
    const renders = await client.render({ source }, RENDER_TIMEOUT_SEC);
    render = renders[0];
    if (!render || render.status !== 'succeeded') {
      const status = render?.status ?? 'missing';
      const msg = render?.errorMessage ?? '(none)';
      await safeRecordEvent(jobId, 'creatomate_rendering', CreatomateEvents.RenderFailed, {
        renderStatus: status,
        errorMessage: msg,
      });
      throw new Error(`[${jobId}] Creatomate render failed: status=${status} ${msg}`);
    }
  } catch (err) {
    // 5xx / network 等非业务错误 — record as Failed, rethrow 让 pipeline.failed.
    if (!(err instanceof Error && err.message.startsWith(`[${jobId}] Creatomate render failed`))) {
      await safeRecordEvent(jobId, 'creatomate_rendering', CreatomateEvents.RenderFailed, {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }

  if (!render.url) {
    throw new Error(`[${jobId}] Creatomate render succeeded but no url returned`);
  }

  // 7. Download mp4.
  const outPath = path.join(jobDir, 'video.mp4');
  const dlRes = await fetch(render.url);
  if (!dlRes.ok) {
    throw new Error(
      `[${jobId}] failed to download Creatomate render: status=${dlRes.status}`,
    );
  }
  await fs.writeFile(outPath, Buffer.from(await dlRes.arrayBuffer()));

  // 8. 写 completed event + artifacts + jobs.update + 清理.
  await safeRecordEvent(jobId, 'creatomate_rendering', CreatomateEvents.RenderCompleted, {
    renderId: render.id,
  });

  const sizeBytes = (await fs.stat(outPath)).size;
  const db = getDb();
  await db.insert(jobArtifacts).values({
    jobId,
    kind: 'mp4',
    storagePath: outPath,
    sizeBytes,
  });
  await db.update(jobs).set({ templateId: 'beat5-30s' }).where(eq(jobs.id, jobId));

  await fs.rm(framesDir, { recursive: true, force: true });
  if (audioPath) await fs.unlink(audioPath).catch(() => {});

  logger.info(
    { jobId, outPath, sizeBytes, renderId: render.id, renderUrl: render.url },
    'creatomate encode done',
  );
}
