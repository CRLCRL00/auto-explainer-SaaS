import { describe, it, expect } from 'vitest';
import { computeRealFps } from '@/worker/phases/fps';

describe('computeRealFps', () => {
  it('computes fps from 30 frames spanning ~1s', () => {
    const now = Date.now();
    // 30 frames at ~30fps means ~34ms apart; 29 gaps × 34ms ≈ 986ms wall clock.
    const frames = Array.from({ length: 30 }, (_, i) => ({
      name: `f_${String(i).padStart(5, '0')}.png`,
      mtimeMs: now + i * 34,
    }));
    expect(computeRealFps(frames)).toBeCloseTo(30, 0);
  });

  it('returns 0 for empty', () => {
    expect(computeRealFps([])).toBe(0);
  });

  it('returns 0 for identical mtimes', () => {
    expect(computeRealFps([{ name: 'a', mtimeMs: 100 }, { name: 'b', mtimeMs: 100 }])).toBe(0);
  });
});