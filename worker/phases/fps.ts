import fs from 'fs/promises';
import path from 'path';

export interface FrameMeta {
  name: string;
  mtimeMs: number;
}

export async function loadFramesMeta(framesDir: string): Promise<FrameMeta[]> {
  const files = (await fs.readdir(framesDir))
    .filter((f) => f.startsWith('f_') && f.endsWith('.png'))
    .sort();
  const stats = await Promise.all(
    files.map(async (name) => {
      const s = await fs.stat(path.join(framesDir, name));
      return { name, mtimeMs: s.mtimeMs };
    }),
  );
  return stats;
}

export function computeRealFps(frames: FrameMeta[]): number {
  if (frames.length < 2) return 0;
  const first = frames[0].mtimeMs;
  const last = frames[frames.length - 1].mtimeMs;
  const wallSec = (last - first) / 1000;
  if (wallSec <= 0) return 0;
  return Math.round((frames.length / wallSec) * 10) / 10;
}