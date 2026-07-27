import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/env', () => ({ getEnv: vi.fn() }));

// mock SDK v3 — 关键: vi.mock 用 factory 返回 object 而非 class
const mockConfigure = vi.fn();
const mockTasksTrigger = vi.fn();
vi.mock('@trigger.dev/sdk/v3', () => ({
  configure: mockConfigure,
  tasks: { trigger: mockTasksTrigger },
}));

import { getEnv } from '@/lib/env';
import { triggerJob } from '@/lib/trigger';

const mockedGetEnv = vi.mocked(getEnv);

describe('triggerJob (P1 PR2 — server-side SDK trigger)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. throws when RUN_TRIGGER_DEV !== "1"', async () => {
    mockedGetEnv.mockReturnValue({ RUN_TRIGGER_DEV: '0' } as never);
    await expect(triggerJob({ jobId: 'job-1' })).rejects.toThrow(/RUN_TRIGGER_DEV=0/);
    expect(mockConfigure).not.toHaveBeenCalled();
    expect(mockTasksTrigger).not.toHaveBeenCalled();
  });

  it('2. throws when TRIGGER_PROJECT_REF missing', async () => {
    mockedGetEnv.mockReturnValue({
      RUN_TRIGGER_DEV: '1',
      TRIGGER_SECRET_KEY: 'trigger-secret-key-1234567890',
      TRIGGER_API_URL: 'http://trigger-web:3030',
    } as never);
    await expect(triggerJob({ jobId: 'job-1' })).rejects.toThrow(/TRIGGER_PROJECT_REF/);
    expect(mockConfigure).not.toHaveBeenCalled();
  });

  it('3. throws when TRIGGER_API_URL missing', async () => {
    mockedGetEnv.mockReturnValue({
      RUN_TRIGGER_DEV: '1',
      TRIGGER_PROJECT_REF: 'proj_test',
      TRIGGER_SECRET_KEY: 'trigger-secret-key-1234567890',
    } as never);
    await expect(triggerJob({ jobId: 'job-1' })).rejects.toThrow(/TRIGGER_API_URL/);
    expect(mockConfigure).not.toHaveBeenCalled();
  });

  it('4. happy path: env OK + SDK returns id → returns { runId }', async () => {
    mockedGetEnv.mockReturnValue({
      RUN_TRIGGER_DEV: '1',
      TRIGGER_PROJECT_REF: 'proj_test',
      TRIGGER_SECRET_KEY: 'trigger-secret-key-1234567890',
      TRIGGER_API_URL: 'http://trigger-web:3030',
      TRIGGER_DEPLOYMENT: 'self-hosted',
    } as never);
    mockTasksTrigger.mockResolvedValue({ id: 'run-abc-123' });

    const out = await triggerJob({ jobId: 'job-1' });

    expect(out).toEqual({ runId: 'run-abc-123' });
    expect(mockConfigure).toHaveBeenCalledTimes(1);
    expect(mockConfigure).toHaveBeenCalledWith({
      secretKey: 'trigger-secret-key-1234567890',
      apiUrl: 'http://trigger-web:3030',
      projectRef: 'proj_test',
    });
    expect(mockTasksTrigger).toHaveBeenCalledWith('process-video-job', { jobId: 'job-1' });
  });

  it('5. throws when SDK returns no run id', async () => {
    mockedGetEnv.mockReturnValue({
      RUN_TRIGGER_DEV: '1',
      TRIGGER_PROJECT_REF: 'proj_test',
      TRIGGER_SECRET_KEY: 'trigger-secret-key-1234567890',
      TRIGGER_API_URL: 'http://trigger-web:3030',
      TRIGGER_DEPLOYMENT: 'self-hosted',
    } as never);
    mockTasksTrigger.mockResolvedValue({ /* no id */ });

    await expect(triggerJob({ jobId: 'job-1' })).rejects.toThrow(/未返回 run id/);
  });

  it('6. propagates SDK error (caller-side fallback decision)', async () => {
    mockedGetEnv.mockReturnValue({
      RUN_TRIGGER_DEV: '1',
      TRIGGER_PROJECT_REF: 'proj_test',
      TRIGGER_SECRET_KEY: 'trigger-secret-key-1234567890',
      TRIGGER_API_URL: 'http://trigger-web:3030',
      TRIGGER_DEPLOYMENT: 'self-hosted',
    } as never);
    mockTasksTrigger.mockRejectedValue(new Error('SDK internal: task not registered'));

    await expect(triggerJob({ jobId: 'job-1' })).rejects.toThrow(/task not registered/);
  });
});
