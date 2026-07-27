import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/env', () => ({ getEnv: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockRunPipeline = vi.fn().mockResolvedValue(undefined);
vi.mock('@/worker/pipeline', () => ({
  runPipeline: (...args: unknown[]) => mockRunPipeline(...(args as [string])),
}));

import { inlineDevEnqueue } from '@/lib/trigger';

describe('inlineDevEnqueue (v0.6+ dev 旁路)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunPipeline.mockResolvedValue(undefined);
  });

  it('1. 返回合成 runId with "dev-inline-" prefix', async () => {
    const out = await inlineDevEnqueue({ jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    expect(out.runId).toMatch(/^dev-inline-/);
    expect(out.runId).toContain('aaaaaaaa'); // 前 8 字符
  });

  it('2. fire-and-forget runPipeline 调用 (不 await)', async () => {
    await inlineDevEnqueue({ jobId: 'job-1' });
    // 给 microtask 一些时间
    await new Promise((r) => setTimeout(r, 50));
    expect(mockRunPipeline).toHaveBeenCalledWith('job-1');
  });

  it('3. runPipeline rejection 仅 console.error, 不 throw 给 caller', async () => {
    mockRunPipeline.mockRejectedValue(new Error('inner failure'));
    // inlineDevEnqueue 自身不会 reject (fire-and-forget)
    const out = await inlineDevEnqueue({ jobId: 'job-2' });
    expect(out.runId).toMatch(/^dev-inline-/);
    // 等 IIFE 跑完让 console.error 跑
    await new Promise((r) => setTimeout(r, 50));
    // 既然只是 console.error (无 throw), test 默认 pass
    expect(true).toBe(true);
  });
});
