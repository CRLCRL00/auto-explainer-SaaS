// Creatomate SaaS render path (P0 POC).
//
// 设计简化 (相对 phaseEncode / FFmpeg):
//   - frames 是 Puppeteer record 阶段 (32 buffer, 30fps, ~30s) 输出的 PNG 序列。
//   - POC: 把首张 frame 上传为静态 Image element, duration=30s (POC 不拼 frame 序列)。
//   - 全量版: 后续 PR 把 frames 序列化为 Composition + Video-style frames (single frame → bg 占位)。
//
// 入参: jobId (string) — 与 phaseEncode 同签名
// 出参: storage/jobs/{jobId}/video.mp4 + job_artifacts(kind='mp4') 行
//
// 环境依赖:
//   - CREATOMATE_API_KEY 必填 (POC 阶段：getEnv schema optional, 但函数内 hard-fail)
//   - framesDir 必须存在 (Puppeteer record 阶段已写过)
//
// SDK 真实 package: 'creatomate' (不是 @creatomate/creatomate — 后者 404)
//   CommonJS default export: const Creatomate = require('creatomate')

import path from 'node:path';
import fs from 'node:fs/promises';
import Creatomate from 'creatomate';
import { getEnv } from '@/lib/env';

export const DEFAULT_OUTPUT_WIDTH = 1080;
export const DEFAULT_OUTPUT_HEIGHT = 1920;
export const DEFAULT_DURATION_SEC = 30;
export const RENDER_TIMEOUT_SEC = 600; // 10 分钟上限 (SDK doc)

export async function phaseEncodeCreatomate(
  jobId: string,
  opts: { jobDir?: string } = {},
): Promise<void> {
  // Lazy imports: logger/db/schema/drizzle are heavy; defer to module-level init 之外
  const { logger } = await import('@/lib/logger');
  const { getDb } = await import('@/lib/db');
  const { jobArtifacts, jobs } = await import('@/lib/schema');
  const { eq } = await import('drizzle-orm');

  const env = getEnv();
  if (!env.CREATOMATE_API_KEY) {
    throw new Error(
      '[P0 POC] CREATOMATE_API_KEY not configured — set it in .env.local or unset RUN_CREATOMATE_POC to fall back to FFmpeg',
    );
  }

  const jobDir = opts.jobDir ?? path.join(process.cwd(), 'storage', 'jobs', jobId);
  const framesDir = path.join(jobDir, 'frames');

  // 取首张 PNG frame 作为静态背景 (POC 简化)
  const frameNames = await fs.readdir(framesDir);
  const pngFrames = frameNames.filter((n) => n.endsWith('.png')).sort();
  if (pngFrames.length === 0) {
    throw new Error(`[${jobId}] no PNG frames in ${framesDir} — record phase broken?`);
  }
  const firstFrame = pngFrames[0];

  logger.info(
    { jobId, framesFound: pngFrames.length, firstFrame, renderWidth: DEFAULT_OUTPUT_WIDTH, renderHeight: DEFAULT_OUTPUT_HEIGHT },
    'creatomate encode starting',
  );

  const client = new Creatomate.Client(env.CREATOMATE_API_KEY);
  const source = new Creatomate.Source({
    outputFormat: 'mp4',
    width: DEFAULT_OUTPUT_WIDTH,
    height: DEFAULT_OUTPUT_HEIGHT,
    duration: DEFAULT_DURATION_SEC,
    frameRate: 30,
    elements: [
      new Creatomate.Image({
        source: `file://${path.join(framesDir, firstFrame)}`,
        fit: 'cover', // 1080×1920 cover from rendered screen
      }),
    ],
  });

  // 提交渲染; SDK 内部 polling — 等到 status=succeeded 才返回 (默认同步)
  const renders = await client.render({ source }, RENDER_TIMEOUT_SEC);
  const render = renders[0];
  if (!render || render.status !== 'succeeded') {
    throw new Error(
      `[${jobId}] Creatomate render failed: status=${render?.status ?? 'missing'} errorMessage=${render?.errorMessage ?? '(none)'}`,
    );
  }

  if (!render.url) {
    throw new Error(`[${jobId}] Creatomate render succeeded but no url returned`);
  }

  // 下载渲染产物到本地 mp4
  const outPath = path.join(jobDir, 'video.mp4');
  const downloadRes = await fetch(render.url);
  if (!downloadRes.ok) {
    throw new Error(
      `[${jobId}] failed to download Creatomate render: status=${downloadRes.status}`,
    );
  }
  const buffer = Buffer.from(await downloadRes.arrayBuffer());
  await fs.writeFile(outPath, buffer);

  // 写 artifact + 更新 jobs (与 phaseEncode 同契约)
  const sizeBytes = (await fs.stat(outPath)).size;
  const db = getDb();
  await db.insert(jobArtifacts).values({
    jobId,
    kind: 'mp4',
    storagePath: outPath,
    sizeBytes,
  });
  await db.update(jobs).set({ templateId: 'beat5-30s' }).where(eq(jobs.id, jobId));

  // 清理 frames — 与 phaseEncode 一致
  await fs.rm(framesDir, { recursive: true, force: true });

  logger.info(
    { jobId, outPath, sizeBytes, renderId: render.id, renderUrl: render.url },
    'creatomate encode done',
  );
}
