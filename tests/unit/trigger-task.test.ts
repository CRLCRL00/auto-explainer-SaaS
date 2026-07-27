import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
}));

// vi.hoisted: vitest 推荐的"提到顶层但仍能被 vi.mock factory reference"模式
const refs = vi.hoisted(() => ({
  taskConfig: null as { id: string; run: Function } | null,
  runPipeline: vi.fn(),
}));

vi.mock('@trigger.dev/sdk/v3', () => ({
  task: (config: { id: string; run: Function }) => {
    refs.taskConfig = config;
    return config;
  },
}));

vi.mock('@/worker/pipeline', () => ({
  runPipeline: refs.runPipeline,
}));

// Top-level import: triggers SDK task() registration once on module evaluation.
// ESM caches the module body, so taskConfig capture is stable across tests.
import '@/trigger/jobs';

const mockedRunPipeline = vi.mocked(refs.runPipeline);

describe('processVideoJob (Trigger.dev v3 task handler)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. registers with id "process-video-job"', () => {
    expect(refs.taskConfig).not.toBeNull();
    expect(refs.taskConfig!.id).toBe('process-video-job');
  });

  it('2. run() invokes runPipeline with payload.jobId and returns { ok, jobId }', async () => {
    mockedRunPipeline.mockResolvedValue(undefined);
    const ctx = { run: { id: 'r-abc-1' } };
    const result = await refs.taskConfig!.run({ jobId: 'job-1' }, ctx);
    expect(mockedRunPipeline).toHaveBeenCalledWith('job-1');
    expect(result).toEqual({ ok: true, jobId: 'job-1' });
  });

  it('3. run() rethrows when runPipeline rejects (SDK marks run as failed)', async () => {
    mockedRunPipeline.mockRejectedValue(new Error('pipeline blew up'));
    const ctx = { run: { id: 'r-abc-2' } };
    await expect(refs.taskConfig!.run({ jobId: 'job-2' }, ctx)).rejects.toThrow('pipeline blew up');
  });
});
