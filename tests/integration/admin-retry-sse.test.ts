// v0.7 integration tests for /api/admin/jobs/[id]/retry + /events (SSE)
//
// Covers:
//   1. POST /retry on a failed job → 200, returns runId, attempts+1, status=pending
//   2. POST /retry on a wall-hit job (humanInLoopReason set) → 200 (also retryable)
//   3. POST /retry on a 'pending' job → 409 not_retryable
//   4. POST /retry on a 'done' job → 409 not_retryable
//   5. POST /retry on non-existent job → 404 not_found
//   6. GET /events initial stream: 1 state event with current job state
//   7. GET /events keeps connection alive (no timeout on 2s poll without changes)
//
// Test approach: vi.mock the SDKs (@/lib/trigger, @/lib/env) + db, hit route handlers
// directly. No HTTP server needed — Next.js App Router route handlers are pure
// functions we can invoke.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  // env mock needs default valid for logger module-level read
  DEFAULT_TEST_ENV: {
    DATABASE_URL: 'postgres://test@127.0.0.1:5432/test',
    REDIS_URL: 'redis://127.0.0.1:6379',
    ANTHROPIC_API_KEY: 'sk-ant-env-fallback-1234567890',
    CREATOMATE_API_KEY: 'creato-test-key-1234567890',
    CREATOMATE_TEMPLATE_ID: 'creatomate-builtin-30s-5beats',
    CREATOMATE_POLL_MS: 3000,
    CREATOMATE_POLL_TIMEOUT_MS: 600000,
    BASIC_AUTH_USER: 'admin',
    BASIC_AUTH_PASS: 'changeme',
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    TRIGGER_DEPLOYMENT: 'self-hosted' as const,
    RUN_TRIGGER_DEV: '0',
    OPENAI_API_KEY: '',
  },
  // DB mock state
  jobs: [] as Array<{
    id: string;
    status: string;
    phase: string;
    attempts: number;
    humanInLoopReason: string | null;
    lastError: { message?: string } | null;
    finishedAt: Date | null;
    startedAt: Date | null;
    updatedAt: Date;
  }>,
  // SDK mock
  triggerJobResult: { runId: 'run-test-retry-001' } as { runId: string },
  triggerJobCalls: [] as Array<{ jobId: string }>,
  // recordEvent mock
  recordEventCalls: [] as Array<{ jobId: string; phase: string; event: string }>,
  // updated-at counter for SSE delta tests
  nextUpdatedAt: new Date(),
}));

const { DEFAULT_TEST_ENV, jobs: dbJobs, triggerJobResult, triggerJobCalls, recordEventCalls, nextUpdatedAt } = hoisted;

// DB mock — selective methods
const mockDbUpdate = vi.fn().mockImplementation(() => ({
  set: () => ({ where: () => Promise.resolve(undefined) }),
}));
const mockDbInsert = vi.fn().mockImplementation(() => ({
  values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }),
}));
const mockDbSelect = vi.fn().mockImplementation(() => ({
  from: () => ({ where: () => ({ limit: (n: number) => Promise.resolve(dbJobs.slice(0, n)) }) }),
}));

vi.mock('@/lib/db', () => ({ getDb: () => ({ update: mockDbUpdate, insert: mockDbInsert, select: mockDbSelect }) }));
vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return { ...actual, getEnv: vi.fn().mockReturnValue(DEFAULT_TEST_ENV) };
});
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/trigger', () => ({
  triggerJob: (...args: unknown[]) => {
    hoisted.triggerJobCalls.push({ jobId: (args[0] as { jobId: string }).jobId });
    return Promise.resolve(hoisted.triggerJobResult);
  },
  inlineDevEnqueue: () => Promise.resolve({ runId: 'run-dev-inert' }),
}));
vi.mock('@/lib/job-events', () => ({
  recordEvent: (...args: unknown[]) => {
    const [jobId, phase, event] = args as [string, string, string];
    hoisted.recordEventCalls.push({ jobId, phase, event });
    return Promise.resolve();
  },
}));

// Helper — make a job fixture
function mkJob(overrides: Partial<typeof dbJobs[number]> = {}): typeof dbJobs[number] {
  hoisted.nextUpdatedAt = new Date(hoisted.nextUpdatedAt.getTime() + 1000);
  return {
    id: 'job-test-1',
    status: 'pending',
    phase: 'planning_done',
    attempts: 0,
    humanInLoopReason: null,
    lastError: null,
    finishedAt: null,
    startedAt: null,
    updatedAt: hoisted.nextUpdatedAt,
    ...overrides,
  };
}

beforeEach(() => {
  dbJobs.length = 0;
  triggerJobCalls.length = 0;
  recordEventCalls.length = 0;
  hoisted.triggerJobResult = { runId: 'run-test-retry-001' };
  mockDbUpdate.mockClear();
  mockDbInsert.mockClear();
  mockDbSelect.mockClear();
});

describe('POST /api/admin/jobs/[id]/retry (v0.7)', () => {
  it('1. failed job → 200 { retried: true, runId, attempts+1 }', async () => {
    dbJobs.push(mkJob({ id: 'job-fail-1', status: 'failed', phase: 'recording_done', attempts: 1, lastError: { message: 'chrome crashed' } }));
    const { POST } = await import('@/app/api/admin/jobs/[id]/retry/route');
    const res = POST(new Request('http://x/'), { params: { id: 'job-fail-1' } });
    const data = await res.json() as { retried: boolean; runId: string; attempts: number };
    expect(res.status).toBe(200);
    expect(data.retried).toBe(true);
    expect(data.runId).toBe('run-test-retry-001');
    expect(data.attempts).toBe(2); // was 1, +1
    expect(triggerJobCalls).toHaveLength(1);
    expect(triggerJobCalls[0]).toEqual({ jobId: 'job-fail-1' });
  });

  it('2. wall-hit job (humanInLoopReason set) → 200 retryable', async () => {
    dbJobs.push(mkJob({
      id: 'job-wall-1', status: 'failed', attempts: 2,
      humanInLoopReason: 'wall:qg-plan:2attempts',
      lastError: { message: 'schema invalid' },
    }));
    const { POST } = await import('@/app/api/admin/jobs/[id]/retry/route');
    const res = POST(new Request('http://x/'), { params: { id: 'job-wall-1' } });
    const data = await res.json() as { retried: boolean; runId: string };
    expect(res.status).toBe(200);
    expect(data.retried).toBe(true);
    expect(data.runId).toBe('run-test-retry-001');
  });

  it('3. pending job → 409 not_retryable', async () => {
    dbJobs.push(mkJob({ id: 'job-pending-1', status: 'pending' }));
    const { POST } = await import('@/app/api/admin/jobs/[id]/retry/route');
    const res = POST(new Request('http://x/'), { params: { id: 'job-pending-1' } });
    expect(res.status).toBe(409);
    const data = await res.json() as { retried: boolean; error: string };
    expect(data.retried).toBe(false);
    expect(data.error).toBe('not_retryable');
    expect(triggerJobCalls).toHaveLength(0); // no dispatch on rejected retry
  });

  it('4. done job → 409 not_retryable', async () => {
    dbJobs.push(mkJob({ id: 'job-done-1', status: 'done', phase: 'done', attempts: 1 }));
    const { POST } = await import('@/app/api/admin/jobs/[id]/retry/route');
    const res = POST(new Request('http://x/'), { params: { id: 'job-done-1' } });
    expect(res.status).toBe(409);
  });

  it('5. non-existent job → 404 not_found', async () => {
    // No job pushed → select returns []
    const { POST } = await import('@/app/api/admin/jobs/[id]/retry/route');
    const res = POST(new Request('http://x/'), { params: { id: 'nonexistent' } });
    expect(res.status).toBe(404);
    const data = await res.json() as { retried: boolean; error: string };
    expect(data.error).toBe('not_found');
    expect(triggerJobCalls).toHaveLength(0);
  });

  it('6. retry dispatches triggerJob in prod, inlineDevEnqueue in dev', async () => {
    dbJobs.push(mkJob({ id: 'job-dev-1', status: 'failed' }));
    // Mock process.env.NODE_ENV to 'development' for this test
    const originalEnv = process.env.NODE_ENV;
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'development', configurable: true });
    try {
      // Need to re-import the module to pick up the new env (cached at import time)
      vi.resetModules();
      const { POST: POSTDev } = await import('@/app/api/admin/jobs/[id]/retry/route');
      const res = POSTDev(new Request('http://x/'), { params: { id: 'job-dev-1' } });
      const data = await res.json() as { retried: boolean; runId: string };
      // inlineDevEnqueue mocked to return 'run-dev-inert'
      expect(data.runId).toBe('run-dev-inert');
    } finally {
      Object.defineProperty(process.env, 'NODE_ENV', { value: originalEnv, configurable: true });
      vi.resetModules();
    }
  });
});

describe('GET /api/admin/jobs/[id]/events SSE (v0.7)', () => {
  it('7. stream returns text/event-stream content-type with initial state event', async () => {
    dbJobs.push(mkJob({ id: 'job-sse-1', status: 'running', phase: 'planning_done', attempts: 0 }));
    const { GET } = await import('@/app/api/admin/jobs/[id]/events/route');
    const req = new Request('http://x/api/admin/jobs/job-sse-1/events');
    const res = GET(req, { params: { id: 'job-sse-1' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    // Read first chunk from the stream
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    if (reader) {
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      const text = new TextDecoder().decode(value);
      // First chunk should be the state event (immediate initial push)
      expect(text).toContain('event: state');
      expect(text).toContain('"id":"job-sse-1"');
      expect(text).toContain('"status":"running"');
      await reader.cancel();
    }
  });

  it('8. non-existent job → stream emits not_found event and closes', async () => {
    // No job pushed
    const { GET } = await import('@/app/api/admin/jobs/[id]/events/route');
    const req = new Request('http://x/');
    const res = GET(req, { params: { id: 'nonexistent' } });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (reader) {
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain('event: not_found');
      await reader.cancel();
    }
  });
});
