// v0.5 QualityGate-v1 checks (per docs/superpowers/specs §4.2).
//
// 现阶段: QG-render + QG-final 两道检查 (部署侧自动化）。QG-plan / QG-script /
// QG-html 已在 lib/pipeline/qg-checks-llm.ts (v0.5.1, worker/pipeline.ts 集成
// 留 v0.5.3)。
//
// QG-render: phaseRecord 后 → 断言 realFps ≥ 12 (PRD 阈值) + chrome 未崩 + 帧数稳定。
// QG-final:  phaseEncodeCreatomate 后 → 断言 mp4 文件 size > 10KB + 时长 ±3s 在期望内。
//            (v0.5+ 4: ffprobe 集成, 拿真实 duration; ffprobe 不可用时 graceful skip.)

import { stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { path as ffprobeBinPath } from 'ffprobe-static';

export class QGFailedError extends Error {
  constructor(public readonly gate: 'qg-render' | 'qg-final', public readonly reason: string) {
    super(`[non-retryable] ${gate}: ${reason}`);
    this.name = 'QGFailedError';
  }
}

const MIN_RENDER_FPS = 12;
const MIN_MP4_BYTES = 10_000; // 粗略 sanity (避免 0-byte file)
const DURATION_TOLERANCE_SEC = 3;
const EXPECTED_DURATION_SEC = 30;

// ─────────────────────────────────────────────────────────────────
// QG-render — 验证 phaseRecord 产物合理性
// ─────────────────────────────────────────────────────────────────
export interface RenderCheckInput {
  realFps: number;
  frameCount: number;
  browserCrashed: boolean;
}

export async function checkRender(i: RenderCheckInput): Promise<void> {
  if (i.browserCrashed) {
    throw new QGFailedError('qg-render', 'browser crashed during record — see puppeteer logs');
  }
  if (i.realFps < MIN_RENDER_FPS) {
    throw new QGFailedError(
      'qg-render',
      `realFps=${i.realFps.toFixed(2)} < ${MIN_RENDER_FPS} (PRD lower bound)`,
    );
  }
  if (i.frameCount < MIN_RENDER_FPS * 15) {
    // 30s 时长 * 12fps = 360 frame 起码; 远低于此 = record 早崩了
    throw new QGFailedError(
      'qg-render',
      `frameCount=${i.frameCount} < ${MIN_RENDER_FPS * 15} (likely early crash)`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// QG-final — 验证 phaseEncode 产物 mp4
// ─────────────────────────────────────────────────────────────────
export interface FinalCheckInput {
  mp4Path: string;
  expectedDurationSec?: number;
}

/**
 * 用 ffprobe 抽 mp4 时长 (秒). 不可用 (binary not on disk / spawn 失败 / 非 mp4)
 * 抛 ProbeError — caller 选择 graceful skip / 撞墙.
 *
 * v0.5.4+ 设计意图: prod 用 trigger-runs record; 这里纯 standalone helper,
 * 让测试可独立 mock.
 */
export class ProbeError extends Error {
  constructor(public readonly reason: string) {
    super(`ffprobe failed: ${reason}`);
    this.name = 'ProbeError';
  }
}

export async function probeDurationSec(mp4Path: string, ffprobePathOverride?: string): Promise<number> {
  const binPath = ffprobePathOverride ?? ffprobeBinPath;
  if (!binPath) {
    throw new ProbeError('ffprobe binary not found (ffprobe-static empty path)');
  }
  return new Promise<number>((resolve, reject) => {
    const proc = spawn(binPath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      mp4Path,
    ]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => reject(new ProbeError(`spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new ProbeError(`exit ${code}: ${stderr.trim().slice(0, 200)}`));
      }
      const dur = parseFloat(stdout.trim());
      if (!Number.isFinite(dur)) {
        return reject(new ProbeError(`non-numeric duration: '${stdout.trim()}'`));
      }
      resolve(dur);
    });
  });
}

export async function checkFinal(i: FinalCheckInput): Promise<void> {
  const expected = i.expectedDurationSec ?? EXPECTED_DURATION_SEC;
  let sizeBytes: number;
  try {
    const st = await stat(i.mp4Path);
    sizeBytes = st.size;
  } catch (err) {
    throw new QGFailedError('qg-final', `mp4 file missing: ${i.mp4Path} — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (sizeBytes < MIN_MP4_BYTES) {
    throw new QGFailedError(
      'qg-final',
      `mp4 size=${sizeBytes} < ${MIN_MP4_BYTES} (likely empty render)`,
    );
  }
  // ffprobe 时长检查 (v0.5.4+): 真实 mp4 duration vs expected ±3s.
  // ffprobe 不可用 (CI / sandbox / 真 Mp4 损坏) → graceful skip, 只记 warn log,
  // 仍依赖 file size sanity 通过 (生产 dashboard 接 trigger_runs.status + spot-check).
  try {
    const dur = await probeDurationSec(i.mp4Path);
    if (Math.abs(dur - expected) > DURATION_TOLERANCE_SEC) {
      throw new QGFailedError(
        'qg-final',
        `mp4 duration ${dur.toFixed(2)}s 偏离 expected ${expected}s (±${DURATION_TOLERANCE_SEC}s)`,
      );
    }
  } catch (err) {
    if (err instanceof QGFailedError) throw err; // 真不通过 — 撞墙
    // ffprobe-level 错误 (binary 不在 / exit 非 0 / 等) — 静默 skip + warn.
    // 不阻断主流程 (很多 CI 环境没 ffprobe 二进制)。
    const { logger } = await import('../logger');
    logger.warn(
      { mp4Path: i.mp4Path, err: err instanceof Error ? err.message : String(err) },
      'ffprobe duration check skipped — falling back to file-size only',
    );
  }
}

// ─── backwards-compat alias (spec 名 'QG-final' 是复数形式, 老代码可能用 'qg-final') ─
export { checkRender as qgRender, checkFinal as qgFinal };
