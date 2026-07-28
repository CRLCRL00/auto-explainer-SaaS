import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runPhaseWithRetry, assertPipelineBudget, RetryWallHitError } from '@/lib/pipeline/retry';

describe('runPhaseWithRetry (v0.5 retry + 撞墙)', () => {
  beforeEach(async () => { vi.clearAllMocks(); });

  it('1. succeeds first attempt — fn returns, no retry', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const out = await runPhaseWithRetry(fn, { phaseName: 'phaseA' });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('2. retries once on first-attempt failure, then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('recovered');
    const out = await runPhaseWithRetry(fn, {
      phaseName: 'phaseB',
      retryDelayMs: 0, // 加速测
    });
    expect(out).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('3. throws RetryWallHitError after maxAttempts exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('persistent failure'));
    await expect(
      runPhaseWithRetry(fn, { phaseName: 'phaseC', maxAttempts: 2, retryDelayMs: 0 }),
    ).rejects.toThrow(RetryWallHitError);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('4. honours non-retryable error hint — wall hit on attempt 1, no retry', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('[non-retryable] fatal pipeline error'));
    await expect(
      runPhaseWithRetry(fn, { phaseName: 'phaseD', retryDelayMs: 0 }),
    ).rejects.toThrow(RetryWallHitError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('5. qgCheck that throws triggers retry (counterfeit QG fail)', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const qgCheck = vi.fn().mockRejectedValueOnce(new Error('QG failed')).mockResolvedValueOnce(undefined);
    const out = await runPhaseWithRetry(fn, {
      phaseName: 'phaseE',
      qgCheck,
      retryDelayMs: 0,
    });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(qgCheck).toHaveBeenCalledTimes(2);
  });

  it('6. per-attempt timeout enforced — fn hanging throws', async () => {
    // hang forever
    const fn = vi.fn().mockImplementation(() => new Promise(() => {}));
    await expect(
      runPhaseWithRetry(fn, { phaseName: 'phaseF', attemptTimeoutMs: 50, retryDelayMs: 0 }),
    ).rejects.toThrow(RetryWallHitError);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('assertPipelineBudget (wall-clock 整 pipeline 兜底)', () => {
  beforeEach(async () => { vi.clearAllMocks(); });

  it('7. resolves within budget — no timeout', async () => {
    const fn = vi.fn().mockResolvedValue('within-budget');
    const out = await assertPipelineBudget('job-x', 1000, fn);
    expect(out).toBe('within-budget');
  });

  it('8. throws RetryWallHitError when fn exceeds budget', async () => {
    const fn = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('slow'), 200)),
    );
    await expect(
      assertPipelineBudget('job-slow', 50, fn),
    ).rejects.toThrow(RetryWallHitError);
  });
});
