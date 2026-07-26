import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

beforeAll(() => {
  process.env.BASIC_AUTH_USER = process.env.BASIC_AUTH_USER ?? 'admin';
  process.env.BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS ?? 'changeme';
  const tmpDir = mkdtempSync(join(tmpdir(), 'llm-settings-test-'));
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/aesaas';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-test-placeholder-key';
  void tmpDir;
});

afterAll(() => {
  // Test file cwd is project root; llm-settings uses storage/.llm-settings.json
  // which is gitignored. We don't aggressively clean (would require env-relative
  // path resolution). Per-test isolation is acceptable for v0.0.1.
  void rmSync;
});

describe('GET /api/llm-settings', () => {
  it('returns 401 without auth', async () => {
    const { GET } = await import('@/app/api/llm-settings/route');
    const req = new Request('http://x/api/llm-settings', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 200 with auth and never exposes apiKey value', async () => {
    // Seed a setting via the lib so GET has something to redact
    const { writeLlmSettings } = await import('@/lib/llm-settings');
    await writeLlmSettings({ model: 'claude-sonnet-4-5', apiKey: 'sk-ant-secret-must-never-appear-in-response' });

    const { GET } = await import('@/app/api/llm-settings/route');
    const req = new Request('http://x/api/llm-settings', {
      method: 'GET',
      headers: {
        authorization: `Basic ${Buffer.from('admin:changeme').toString('base64')}`,
      },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('sk-ant-secret-must-never-appear-in-response');
    expect(text).not.toContain('apiKey'); // field name also redacted
    const data = JSON.parse(text);
    expect(data).toHaveProperty('configured');
    expect(data).toHaveProperty('model');
  });
});

describe('POST /api/llm-settings', () => {
  it('rejects when apiKey too short', async () => {
    const { POST } = await import('@/app/api/llm-settings/route');
    const req = new Request('http://x/api/llm-settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from('admin:changeme').toString('base64')}`,
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', apiKey: 'short' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('accepts valid model + key', async () => {
    const { POST } = await import('@/app/api/llm-settings/route');
    const req = new Request('http://x/api/llm-settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from('admin:changeme').toString('base64')}`,
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', apiKey: 'sk-ant-api03-test-fake-key-1234567890' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.model).toBe('claude-sonnet-4-5');
    expect(data.configured).toBe(true);
  });
});

describe('DELETE /api/llm-settings', () => {
  it('clears settings when called with auth', async () => {
    const { DELETE } = await import('@/app/api/llm-settings/route');
    const req = new Request('http://x/api/llm-settings', {
      method: 'DELETE',
      headers: {
        authorization: `Basic ${Buffer.from('admin:changeme').toString('base64')}`,
      },
    });
    const res = await DELETE(req);
    expect(res.status).toBe(200);
  });
});
