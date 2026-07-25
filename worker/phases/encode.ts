import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import path from 'path';
import fs from 'fs/promises';
import { loadFramesMeta, computeRealFps } from './fps';

export function buildEncodeArgs(opts: {
  inputFps: number;
  framesPattern: string;
  outputPath: string;
}): string[] {
  return [
    '-y',
    '-framerate', String(opts.inputFps),
    '-i', opts.framesPattern,
    '-vf', 'fps=30',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'slow',
    '-crf', '20',
    '-movflags', '+faststart',
    opts.outputPath,
  ];
}

export async function phaseEncode(jobId: string) {
  // Lazy imports: logger/db/schema/drizzle all touch env or DB at module load.
  const { logger } = await import('@/lib/logger');
  const { getDb } = await import('@/lib/db');
  const { jobArtifacts, jobs } = await import('@/lib/schema');
  const { eq } = await import('drizzle-orm');

  const jobDir = path.join(process.cwd(), 'storage', 'jobs', jobId);
  const framesDir = path.join(jobDir, 'frames');
  const frames = await loadFramesMeta(framesDir);
  const realFps = computeRealFps(frames);
  logger.info({ jobId, realFps, count: frames.length }, 'encode starting');

  const outPath = path.join(jobDir, 'video.mp4');
  const args = buildEncodeArgs({
    inputFps: realFps,
    framesPattern: path.join(framesDir, 'f_%05d.png'),
    outputPath: outPath,
  });

  if (!ffmpegPath) {
    throw new Error(`[${jobId}] ffmpeg-static path unavailable (binary not bundled)`);
  }

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: 'inherit' });
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`[${jobId}] ffmpeg exit ${code}`))));
    proc.on('error', (err) => reject(new Error(`[${jobId}] ffmpeg spawn: ${err.message}`)));
  });

  // 写 artifact 记录
  const sizeBytes = (await fs.stat(outPath)).size;
  const db = getDb();
  await db.insert(jobArtifacts).values({
    jobId, kind: 'mp4', storagePath: outPath, sizeBytes,
  });
  await db.update(jobs).set({ templateId: 'beat5-30s' }).where(eq(jobs.id, jobId));

  // 清理 frames（节省磁盘）
  await fs.rm(framesDir, { recursive: true, force: true });

  logger.info({ jobId, outPath, sizeBytes }, 'encode done');
}