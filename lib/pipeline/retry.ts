// v0.5 retry + wall-clock budget (per plan §7.4 P0.5 + spec §4.2 '撞墙拐点').
//
// 暴露 2 个 helper:
//   - runPhaseWithRetry: phase 级 retry 包装 (maxAttempts + qgCheck).
//     Phase 失败时按 attempt 重试, 直到过 QG / 撞墙 (maxAttempts exhausted).
//   - assertPipelineBudget: pipeline 整体 wall-clock budget 兜底 (秒数).
//     超时 reject, 撞墙语义等同 QG 不通过.
//
// 与 spec §4.2 QualityGate-v1 决策框架契合:
//   QG-X fails ──┐
//     attempt < maxAttempts? ── yes ── 重试 (改一类变量)
//                          └─ no   ── 撞墙 → throw RetryWallHitError

import { logger } from '../logger';

export class RetryWallHitError extends Error {
  constructor(
    public readonly phaseName: string,
    public readonly attempts: number,
    public readonly lastError: unknown,
  ) {
    super(`[撞墙] phase '${phaseName}' failed after ${attempts} attempts — re-evaluating required`);
    this.name = 'RetryWallHitError';
  }
}

export interface RunPhaseOptions {
  /** Phase 名（仅用于 log / error message） */
  phaseName: string;
  /** 最大尝试次数 = 1 + 重试次数；默认 2 (一原始 + 一重试) */
  maxAttempts?: number;
  /** QualityGate 检查；throw → 重试, resolve → 通过 */
  qgCheck?: () => Promise<void> | void;
  /** Wall-clock budget for one attempt (ms); 默认 90s per phase */
  attemptTimeoutMs?: number;
  /** Static delay between attempts (ms); 默认 1500 */
  retryDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 90_000;
const DEFAULT_RETRY_DELAY_MS = 1500;

export interface AttemptResult {
  attempt: number;
  ok: boolean;
  durationMs: number;
  error?: unknown;
}

export async function runPhaseWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RunPhaseOptions,
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const trace: AttemptResult[] = [];

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    try {
      // 一个 attempt 自身有 timeout 兜底 (Phase 挂了不返回会让 budget 拖死)。
      const result = await withTimeout(fn(attempt), attemptTimeoutMs);
      const durationMs = Date.now() - startedAt;

      // QG check (phase 内已落库, 这里只 sanity verify)
      if (opts.qgCheck) {
        await withTimeout(Promise.resolve(opts.qgCheck()), 5_000);
      }

      trace.push({ attempt, ok: true, durationMs });
      logger.info({ phaseName: opts.phaseName, attempt, durationMs }, 'phase attempt ok');
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      trace.push({ attempt, ok: false, durationMs, error: err });
      lastErr = err;
      logger.warn(
        { phaseName: opts.phaseName, attempt, durationMs, err: err instanceof Error ? err.message : String(err) },
        'phase attempt failed',
      );

      // 已经到 maxAttempts → 撞墙, 不再 retry
      if (attempt >= maxAttempts) break;

      // QG-render / QG-final 那种 '不重试' 错误直接撞墙 (用 errorHint signal)
      if (err instanceof Error && err.message.startsWith('[non-retryable]')) {
        logger.warn({ phaseName: opts.phaseName, attempt }, 'QG flagged non-retryable — wall hit');
        break;
      }

      await sleep(retryDelayMs * attempt); // 简单 linear backoff (1x, 2x)
    }
  }

  throw new RetryWallHitError(opts.phaseName, trace.length, lastErr);
}

/** 整 pipeline 兜底 wall-clock budget — 超时 throw RetryWallHitError. */
export async function assertPipelineBudget<T>(
  jobId: string,
  budgetMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await withTimeout(fn(), budgetMs);
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    if (err instanceof Error && err.message.startsWith('[timeout:pipeline-budget]')) {
      logger.error({ jobId, elapsed, budgetMs }, 'pipeline wall-clock budget exceeded');
      throw new RetryWallHitError('pipeline-total', 0, err);
    }
    throw err;
  }
}

// ─── internal helpers ──────────────────────────────────────────────

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`[timeout:pipeline-budget] exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
