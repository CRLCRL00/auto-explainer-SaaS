import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/env', () => ({ getEnv: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { notifyHumanInLoop, buildHILPayload } from '@/lib/notify';

describe('notifyHumanInLoop (v0.5.5)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('1. returns ok:false when webhook URL undefined (graceful skip)', async () => {
    const out = await notifyHumanInLoop(undefined, {
      jobId: 'job-x',
      phaseName: 'creatomate_rendering',
      attempts: 2,
      reason: 'qg-final',
      suggestedActions: ['retry'],
      lastError: { message: 'boom' },
      timestamp: '2026-07-27T00:00:00Z',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('no webhook configured');
  });

  it('2. POSTs JSON to webhook URL (happy path via globalThis.fetch)', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    const out = await notifyHumanInLoop('https://hooks.example.com/x', {
      jobId: 'job-y',
      phaseName: 'recording_done',
      attempts: 2,
      reason: 'qg-render',
      suggestedActions: ['retry'],
      lastError: { message: 'low fps' },
      timestamp: '2026-07-27T00:00:00Z',
    });
    expect(out.ok).toBe(true);
    expect(out.status).toBe(200);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://hooks.example.com/x',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: 'job-y',
          phaseName: 'recording_done',
          attempts: 2,
          reason: 'qg-render',
          suggestedActions: ['retry'],
          lastError: { message: 'low fps' },
          timestamp: '2026-07-27T00:00:00Z',
        }),
      }),
    );
  });

  it('3. returns ok:false when fetch throws (network down etc.)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    const out = await notifyHumanInLoop('https://hooks.example.com/x', {
      jobId: 'job-z',
      phaseName: 'creatomate_rendering',
      attempts: 2,
      reason: 'qg-final',
      suggestedActions: ['retry'],
      lastError: { message: 'boom' },
      timestamp: '2026-07-27T00:00:00Z',
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/network down/);
  });
});

describe('buildHILPayload (mapping)', () => {
  it('4. maps RetryWallHitError shape to HIL payload', () => {
    const inner = new Error('qg-render low fps');
    const errShape = { phaseName: 'recording_done', attempts: 2, lastError: inner };
    const payload = buildHILPayload('job-abc', errShape);
    expect(payload.jobId).toBe('job-abc');
    expect(payload.phaseName).toBe('recording_done');
    expect(payload.attempts).toBe(2);
    expect(payload.reason).toBe('qg-render');
    expect(payload.lastError.message).toBe('qg-render low fps');
    expect(payload.lastError.stack).toBeDefined();
  });

  it('5. handles non-Error lastError gracefully', () => {
    const payload = buildHILPayload('job-x', {
      phaseName: 'creatomate_rendering',
      attempts: 1,
      lastError: 'just a string',
    });
    expect(payload.lastError.message).toBe('just a string');
    expect(payload.lastError.stack).toBeUndefined();
  });
});
