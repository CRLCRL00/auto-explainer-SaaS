import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 测试组：lib/llm-settings.ts
// 这个模块故意没在顶层 import logger，所以无需 env stub 即可直接静态 import。

import {
  clearLlmSettings,
  readLlmSettings,
  redactSettings,
  writeLlmSettings,
} from '@/lib/llm-settings';

let tmpDir: string;
let filePath: string;

beforeAll(() => {
  // 每个 test 文件用独立子目录，避免并跑冲突
  tmpDir = path.join(os.tmpdir(), `llm-settings-${process.pid}-${Date.now()}`);
});

beforeEach(async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  filePath = path.join(tmpDir, `.llm-settings-${Math.random().toString(36).slice(2)}.json`);
});

describe('readLlmSettings', () => {
  it('returns null when file is missing', async () => {
    const missing = path.join(tmpDir, 'does-not-exist.json');
    const result = await readLlmSettings(missing);
    expect(result).toBeNull();
  });

  it('returns null when file contains invalid JSON', async () => {
    const bad = path.join(tmpDir, 'bad.json');
    await fs.writeFile(bad, '{not-json', 'utf8');
    const result = await readLlmSettings(bad);
    expect(result).toBeNull();
  });

  it('returns null when file contains a non-object payload', async () => {
    const bad = path.join(tmpDir, 'non-obj.json');
    await fs.writeFile(bad, '[]', 'utf8');
    const result = await readLlmSettings(bad);
    expect(result).toBeNull();
  });

  it('reads a previously-written settings file', async () => {
    await writeLlmSettings({ model: 'claude-sonnet-4-5', apiKey: 'sk-ant-test-1234567890' }, filePath);
    const result = await readLlmSettings(filePath);
    expect(result).toEqual({ model: 'claude-sonnet-4-5', apiKey: 'sk-ant-test-1234567890' });
  });

  it('omits empty string fields when reading', async () => {
    await writeLlmSettings({ model: '', apiKey: 'sk-ant-test-1234567890' }, filePath);
    const result = await readLlmSettings(filePath);
    expect(result).toEqual({ apiKey: 'sk-ant-test-1234567890' });
    expect(result?.model).toBeUndefined();
  });
});

describe('writeLlmSettings', () => {
  it('creates the parent directory if missing', async () => {
    const nested = path.join(tmpDir, 'nested', 'sub', '.llm-settings.json');
    await writeLlmSettings({ model: 'm', apiKey: 'sk-ant-1234567890' }, nested);
    const stat = await fs.stat(nested);
    expect(stat.isFile()).toBe(true);
  });

  it('overwrites an existing file atomically (no .tmp leftover)', async () => {
    await writeLlmSettings({ model: 'old-model', apiKey: 'sk-ant-old-key-1234' }, filePath);
    await writeLlmSettings({ model: 'new-model', apiKey: 'sk-ant-new-key-5678' }, filePath);

    const result = await readLlmSettings(filePath);
    expect(result).toEqual({ model: 'new-model', apiKey: 'sk-ant-new-key-5678' });

    const tmpLeftover = `${filePath}.tmp`;
    await expect(fs.stat(tmpLeftover)).rejects.toThrow();
  });

  it('omits undefined/empty fields from the persisted payload', async () => {
    await writeLlmSettings({ model: 'only-model', apiKey: '' }, filePath);
    const raw = await fs.readFile(filePath, 'utf8');
    expect(raw).not.toContain('apiKey');
    expect(raw).toContain('only-model');
  });
});

describe('clearLlmSettings', () => {
  it('removes an existing settings file', async () => {
    await writeLlmSettings({ model: 'm', apiKey: 'sk-ant-test-1234567890' }, filePath);
    await clearLlmSettings(filePath);
    await expect(fs.stat(filePath)).rejects.toThrow();
  });

  it('is idempotent when file is missing (does not throw)', async () => {
    await expect(clearLlmSettings(path.join(tmpDir, 'nope.json'))).resolves.toBeUndefined();
  });
});

describe('redactSettings', () => {
  it('returns configured:true and the model when apiKey is present', () => {
    const redacted = redactSettings({ model: 'claude-sonnet-4-5', apiKey: 'sk-ant-very-secret' });
    expect(redacted).toEqual({ model: 'claude-sonnet-4-5', configured: true });
    expect(JSON.stringify(redacted)).not.toContain('sk-ant-very-secret');
  });

  it('returns configured:false when apiKey is missing/empty', () => {
    expect(redactSettings({ model: 'm' })).toEqual({ model: 'm', configured: false });
    expect(redactSettings({ model: 'm', apiKey: '' })).toEqual({ model: 'm', configured: false });
  });

  it('returns model:null, configured:false for null input', () => {
    expect(redactSettings(null)).toEqual({ model: null, configured: false });
  });

  it('NEVER exposes apiKey value in the output (regression)', () => {
    const SECRET = 'sk-ant-do-not-leak-very-secret-key-9999';
    const redacted = redactSettings({ model: 'm', apiKey: SECRET });
    // 防御性序列化检查：整个对象的字符串表示里不能出现密钥
    expect(Object.values(redacted)).not.toContain(SECRET);
    expect(Object.keys(redacted)).toEqual(['model', 'configured']);
  });
});
