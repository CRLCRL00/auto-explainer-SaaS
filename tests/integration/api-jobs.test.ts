import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  // set envs that getEnv() will read; otherwise tests will fail when
  // route.ts → lib/db.ts → lib/logger.ts (module-level getEnv()) chain triggers lookup.
  // .env.local isn't auto-loaded by vitest, so all required keys must be set here.
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/aesaas';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-test-placeholder-key';
  process.env.BASIC_AUTH_USER = 'admin';
  process.env.BASIC_AUTH_PASS = 'changeme';
});

const token = Buffer.from('admin:changeme').toString('base64');
const authHeader = { authorization: `Basic ${token}` };

describe('POST /api/jobs', () => {
  it('rejects without auth', async () => {
    const { POST: createJob } = await import('@/app/api/jobs/route');
    const req = new Request('http://x/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputType: 'text', topic: 'RAG 原理' }),
    });
    const res = await createJob(req);
    expect(res.status).toBe(401);
  });

  it('creates a job with valid auth + text input', async () => {
    const { POST: createJob } = await import('@/app/api/jobs/route');
    const req = new Request('http://x/api/jobs', {
      method: 'POST',
      headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ inputType: 'text', topic: 'RAG 原理' }),
    });
    const res = await createJob(req);
    expect(res.status).toBe(201);
    const { jobId } = await res.json();
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns 400 for missing topic', async () => {
    const { POST: createJob } = await import('@/app/api/jobs/route');
    const req = new Request('http://x/api/jobs', {
      method: 'POST',
      headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ inputType: 'text' }),
    });
    const res = await createJob(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty topic', async () => {
    const { POST: createJob } = await import('@/app/api/jobs/route');
    const req = new Request('http://x/api/jobs', {
      method: 'POST',
      headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ inputType: 'text', topic: '' }),
    });
    const res = await createJob(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 for topic > 500 chars', async () => {
    const { POST: createJob } = await import('@/app/api/jobs/route');
    const req = new Request('http://x/api/jobs', {
      method: 'POST',
      headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ inputType: 'text', topic: 'a'.repeat(501) }),
    });
    const res = await createJob(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid JSON', async () => {
    const { POST: createJob } = await import('@/app/api/jobs/route');
    const req = new Request('http://x/api/jobs', {
      method: 'POST',
      headers: { ...authHeader, 'content-type': 'application/json' },
      body: 'not-json',
    });
    const res = await createJob(req);
    expect(res.status).toBe(400);
  });
});