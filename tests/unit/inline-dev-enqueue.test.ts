import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/env', () => ({ getEnv: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// mock DB chain: getDb → update(jobs).set({...}).where(eq(...))
const mockDbUpdate = vi.fn().mockReturnValue({
  set: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  }),
});
vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({ update: mockDbUpdate })) }));
vi.mock('@/lib/schema', () => ({
  jobs: { id: 'jobs.id' }, // placeholder, 同 drizzle table proxy 形状
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ eq: 'mock', a, b })),
}));

// 同步 + 不写真调 runPipeline (commit 第二次改 inlineDevEnqueue 走 status walk-through).
const mockRunPipeline = vi.fn();
vi.mock('@/worker/pipeline', () => ({
  runPipeline: (...args: unknown[]) => mockRunPipeline(...(args as [string])),
}));

import { inlineDevEnqueue } from '@/lib/trigger';

describe('inlineDevEnqueue (v0.6+ dev 旁路 — status walk-through)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbUpdate.mockClear();
    mockRunPipeline.mockClear();
  });

  it('1. 返回合成 runId with "dev-inline-" prefix', async () => {
    const out = await inlineDevEnqueue({ jobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    expect(out.runId).toMatch(/^dev-inline-/);
    expect(out.runId).toContain('aaaaaaaa');
  });

  it('2. 不再调真 runPipeline (status walk-through 改 DB directly)', async () => {
    await inlineDevEnqueue({ jobId: 'job-1' });
    // 让 microtask chain 启动但等时间不够 fire
    await new Promise((r) => setTimeout(r, 50));
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('3. fire-and-forget 不 throw 给 caller, 即使 DB chain 抛错', async () => {
    mockDbUpdate.mockImplementation(() => {
      throw new Error('db chain broken');
    });
    const out = await inlineDevEnqueue({ jobId: 'job-2' });
    // inlineDevEnqueue 自身不等 IIFE, 立即返 runId
    expect(out.runId).toMatch(/^dev-inline-/);
  });
});
