// P0 全量: hard cut 后, FFmpeg 路径退役.
// 这个文件保留为 thin wrapper + 历史兼容性:
//   - 1 个 minor 版本内仍 export buildEncodeArgs (deprecated, 防止外部 import 直接断)
//   - phaseEncode 重新指向 phaseEncodeCreatomate
//
// FFmpeg 静态二进制 (ffmpeg-static / @ffmpeg-installer/ffmpeg) 已从 package.json 卸下.
// 真实渲染路径: 见 ../worker/phases/encode-creatomate.ts.

import { phaseEncodeCreatomate } from './encode-creatomate';

/**
 * @deprecated Use phaseEncodeCreatomate() — same signature, single source of truth.
 * Kept for one minor release to avoid breaking anyone who imported it directly.
 */
export async function phaseEncode(jobId: string, opts: { jobDir?: string } = {}): Promise<void> {
  return phaseEncodeCreatomate(jobId, opts);
}

/**
 * @deprecated No longer used after Creatomate cut-over (P0 全量).
 * Kept as a stub so the existing buildEncodeArgs unit test still imports cleanly.
 * Returns an empty array; remove in next minor.
 */
export function buildEncodeArgs(opts: {
  inputFps: number;
  framesPattern: string;
  outputPath: string;
}): string[] {
  void opts;
  return [];
}
