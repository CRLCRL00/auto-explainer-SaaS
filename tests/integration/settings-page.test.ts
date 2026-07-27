import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;
let settingsPath: string;

beforeAll(() => {
  process.env.BASIC_AUTH_USER = process.env.BASIC_AUTH_USER ?? 'admin';
  process.env.BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS ?? 'changeme';
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/aesaas';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-test-placeholder-key';
  // P0 全量: CREATOMATE_API_KEY required in lib/env.ts; stub 进来.
  process.env.CREATOMATE_API_KEY = process.env.CREATOMATE_API_KEY ?? 'creato-test-key-1234567890';
  // vitest worker 不支持 process.chdir() — 改用 vi.spyOn mock DEFAULT_SETTINGS_PATH 模块导出。
  // 但 llm-settings 模块用 module-level const DEFAULT_SETTINGS_PATH 固化，spy 不生效。
  // 改方案: mock 整个 @/lib/llm-settings 模块，把 read/write/clear 全部重定向到 tmpDir。
  tmpDir = mkdtempSync(join(tmpdir(), 'llm-settings-test-'));
  settingsPath = join(tmpDir, '.llm-settings.json');
  // 提前创建父目录让 fs.mkdir 在 writeLlmSettings 里不报
  mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Mock 整个 lib/llm-settings 模块，让 read/write/clear 都打到 tmpDir 而不是项目根 storage/
vi.mock('@/lib/llm-settings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/llm-settings')>('@/lib/llm-settings');
  return {
    ...actual,
    DEFAULT_SETTINGS_PATH: settingsPath,
    readLlmSettings: async (filePath: string = settingsPath) => actual.readLlmSettings(filePath),
    writeLlmSettings: async (settings: typeof actual.LlmSettings.prototype, filePath: string = settingsPath, opts?: { merge?: boolean }) => {
      return actual.writeLlmSettings(settings, filePath, opts);
    },
    clearLlmSettings: async (filePath: string = settingsPath) => actual.clearLlmSettings(filePath),
    redactSettings: actual.redactSettings,
  };
});

describe('GET /api/llm-settings', () => {
  it('returns 401 without auth', async () => {
    const { GET } = await import('@/app/api/llm-settings/route');
    const req = new Request('http://x/api/llm-settings', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 200 with auth and never exposes apiKey value', async () => {
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